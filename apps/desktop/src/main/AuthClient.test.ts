// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server plays Lazurio Auth.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  AuthClient,
  AuthUnreachableError,
  CLIENT_ID,
  DEVICE_ENTRY_SCOPE,
  layer,
  type InvalidIssuerError,
  SignedOutError,
  SignInError,
  type AuthClientOptions,
  type AuthClientShape,
  type HandOver,
} from "./AuthClient.ts";
import type { Keystore } from "./NodeKeys.ts";

const isSignInError = Schema.is(SignInError);
const isSignedOut = Schema.is(SignedOutError);
const isUnreachable = Schema.is(AuthUnreachableError);
// A sign-in's failure as its reason, or the tag of another error.
const signInReason = (error: { readonly _tag: string }): string =>
  isSignInError(error) ? error.reason : error._tag;

// The app's sign-in with Lazurio Auth against a fake Auth on the loopback that follows the
// contract of `lazurio-app` (Authorization Code with PKCE S256, refresh, device-hand-over). The
// system's browser is an HTTP client that follows the redirects a person's browser would.

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const sha256 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

const unsignedJwt = (claims: Record<string, unknown>): string =>
  [{ alg: "none", typ: "JWT" }, claims]
    .map((part) => base64url(new TextEncoder().encode(JSON.stringify(part))))
    .concat("signature")
    .join(".");

// A token's random part, unique across the tests' runs.
const randomPart = (): string => base64url(crypto.getRandomValues(new Uint8Array(12)));

const HAND_OVER = "h".repeat(21) + "AND-over_" + "x".repeat(13);
const ENVIRONMENT_ORIGIN = "https://launchpad.alice.example-org.lazurio.io";

interface Authorization {
  readonly challenge: string;
  readonly method: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly scope: string;
  readonly state: string;
}

interface HandOverRequest {
  readonly method: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

interface FakeAuth {
  readonly issuer: string;
  readonly authorizations: Array<Authorization>;
  readonly verifiers: Array<string>;
  readonly grants: Array<string>;
  readonly handOvers: Array<HandOverRequest>;
  readonly revoked: Array<string>;
  // Every token, code and verifier the fake gave out or received, for the logs' check.
  readonly secrets: Array<string>;
  readonly validAccessTokens: Set<string>;
  settings: {
    accessTokenSeconds: number;
    refresh: "ok" | "reject" | "unavailable";
    handOverStatus: number;
    // The state the redirect carries back, when it should differ from the request's.
    returnState: string | undefined;
    idTokenNonce: string | undefined;
    denyAuthorization: boolean;
  };
}

const readBody = (request: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const fakeAuth = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeHttp.Server; readonly fake: FakeAuth }>((resume) => {
    let counter = 0;
    const next = (kind: string) => `${kind}-SECRET-${++counter}-${randomPart()}`;
    const codes = new Map<string, Authorization>();
    const refreshTokens = new Set<string>();
    const fake: FakeAuth = {
      issuer: "",
      authorizations: [],
      verifiers: [],
      grants: [],
      handOvers: [],
      revoked: [],
      secrets: [],
      validAccessTokens: new Set(),
      settings: {
        accessTokenSeconds: 300,
        refresh: "ok",
        handOverStatus: 200,
        returnState: undefined,
        idTokenNonce: undefined,
        denyAuthorization: false,
      },
    };
    const tokens = (scope: string, nonce: string | undefined) => {
      const accessToken = next("access");
      const refreshToken = next("refresh");
      fake.secrets.push(accessToken, refreshToken);
      fake.validAccessTokens.add(accessToken);
      refreshTokens.add(refreshToken);
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: fake.settings.accessTokenSeconds,
        refresh_token: refreshToken,
        refresh_expires_in: 1800,
        scope,
        ...(nonce === undefined
          ? {}
          : {
              id_token: unsignedJwt({
                iss: fake.issuer,
                aud: CLIENT_ID,
                sub: "person-1",
                nonce: fake.settings.idTokenNonce ?? nonce,
              }),
            }),
      };
    };
    const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
      const url = new URL(request.url ?? "/", fake.issuer);
      const path = url.pathname.slice(new URL(fake.issuer).pathname.length);
      if (request.method === "GET" && path === "/.well-known/openid-configuration") {
        return json(response, 200, {
          issuer: fake.issuer,
          authorization_endpoint: `${fake.issuer}/protocol/auth`,
          token_endpoint: `${fake.issuer}/protocol/token`,
          revocation_endpoint: `${fake.issuer}/protocol/revoke`,
        });
      }
      if (request.method === "GET" && path === "/protocol/auth") {
        const query = url.searchParams;
        const redirectUri = query.get("redirect_uri") ?? "";
        const state = query.get("state") ?? "";
        const authorization: Authorization = {
          challenge: query.get("code_challenge") ?? "",
          method: query.get("code_challenge_method") ?? "",
          redirectUri,
          nonce: query.get("nonce") ?? "",
          scope: query.get("scope") ?? "",
          state,
        };
        fake.authorizations.push(authorization);
        const back = new URL(redirectUri);
        if (fake.settings.denyAuthorization) {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = next("code");
          fake.secrets.push(code);
          codes.set(code, authorization);
          back.searchParams.set("code", code);
        }
        back.searchParams.set("state", fake.settings.returnState ?? state);
        back.searchParams.set("iss", fake.issuer);
        response.writeHead(302, { location: back.toString() });
        return response.end();
      }
      if (request.method === "POST" && path === "/protocol/token") {
        const form = new URLSearchParams(await readBody(request));
        const grant = form.get("grant_type") ?? "";
        fake.grants.push(grant);
        if (form.get("client_id") !== CLIENT_ID || form.has("client_secret")) {
          return json(response, 401, { error: "invalid_client" });
        }
        if (grant === "authorization_code") {
          const code = form.get("code") ?? "";
          const verifier = form.get("code_verifier") ?? "";
          fake.verifiers.push(verifier);
          fake.secrets.push(verifier);
          const authorization = codes.get(code);
          codes.delete(code);
          if (
            authorization === undefined ||
            authorization.redirectUri !== form.get("redirect_uri") ||
            authorization.challenge !== (await sha256(verifier))
          ) {
            return json(response, 400, { error: "invalid_grant" });
          }
          return json(response, 200, tokens(authorization.scope, authorization.nonce));
        }
        if (grant === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (fake.settings.refresh === "unavailable") {
            return json(response, 503, { error: "temporarily_unavailable" });
          }
          if (fake.settings.refresh === "reject" || !refreshTokens.delete(presented)) {
            return json(response, 400, {
              error: "invalid_grant",
              error_description: "Session not active",
            });
          }
          return json(response, 200, tokens(`openid ${DEVICE_ENTRY_SCOPE}`, undefined));
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      if (request.method === "POST" && path === "/protocol/revoke") {
        const form = new URLSearchParams(await readBody(request));
        fake.revoked.push(form.get("token") ?? "");
        response.writeHead(200);
        return response.end();
      }
      if (path === "/lazurio-agent-entry/device-hand-over") {
        const body = await readBody(request);
        const authorization = request.headers.authorization;
        fake.handOvers.push({
          method: request.method ?? "",
          authorization,
          contentType: request.headers["content-type"],
          body,
        });
        if (!fake.validAccessTokens.has((authorization ?? "").replace(/^Bearer /u, ""))) {
          return json(response, 401, { error: "invalid_token" });
        }
        const status = fake.settings.handOverStatus;
        if (status === 200) {
          fake.secrets.push(HAND_OVER);
          return json(response, 200, { handOver: HAND_OVER, expiresIn: 60 });
        }
        return json(
          response,
          status,
          status === 409 ? { error: "environment_state_conflict" } : { error: "refused" },
        );
      }
      response.writeHead(404);
      response.end();
    };
    const server = NodeHttp.createServer((request, response) => {
      handle(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      Object.assign(fake, { issuer: `http://127.0.0.1:${port}/auth-test` });
      resume(Effect.succeed({ server, fake }));
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map(({ fake }) => fake));

// A keystore that seals reversibly but not in the clear, so a test sees that the refresh token
// never reaches the disk as it is.
const fakeKeystore = (overrides: Partial<Keystore> = {}): Keystore => ({
  available: () => true,
  backend: () => undefined,
  seal: (text) => new TextEncoder().encode(`sealed:${base64url(new TextEncoder().encode(text))}`),
  open: (sealed) => {
    const text = new TextDecoder().decode(sealed);
    if (!text.startsWith("sealed:")) throw new Error("not sealed here");
    const encoded = text.slice("sealed:".length).replaceAll("-", "+").replaceAll("_", "/");
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  },
  ...overrides,
});

// A person's browser: it follows Lazurio Auth's redirect back to the app's loopback address and
// returns the page shown there.
const browseOutside = async (address: string) => {
  // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app.
  const authorize = await fetch(address, { redirect: "manual" });
  const callback = authorize.headers.get("location") ?? "";
  // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app.
  const page = await fetch(callback);
  return { callback, status: page.status, headers: page.headers, text: await page.text() };
};
const browse = (address: string) => Effect.promise(() => browseOutside(address));

// Whether anything still listens at the address.
const probe = (address: string): Promise<number | "refused"> =>
  // @effect-diagnostics-next-line globalFetch:off - A probe of the loopback port.
  fetch(address).then(
    (response) => response.status,
    () => "refused" as const,
  );
const answers = (address: string) => Effect.promise(() => probe(address));

interface Harness {
  readonly fake: FakeAuth;
  readonly opened: Queue.Queue<string>;
  readonly sessionPath: string;
  readonly logs: Array<string>;
  readonly client: (
    overrides?: Partial<AuthClientOptions>,
  ) => Effect.Effect<AuthClientShape, InvalidIssuerError>;
}

const withHarness = <A, E>(
  test: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fake = yield* fakeAuth;
    const opened = yield* Queue.unbounded<string>();
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const sessionPath = (yield* Path.Path).join(directory, "auth", "session.sealed");
    const logs: Array<string> = [];
    const capture = Logger.map(Logger.formatJson, (line) => {
      logs.push(line);
    });
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const client = (overrides: Partial<AuthClientOptions> = {}) =>
      Effect.service(AuthClient).pipe(
        Effect.provide(
          layer({
            issuer: fake.issuer,
            keystore: fakeKeystore(),
            sessionPath,
            allowWithoutKeystore: false,
            locale: "en",
            openBrowser: (address) => Queue.offer(opened, address).pipe(Effect.asVoid),
            ...overrides,
          }).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
        Effect.provide(context),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
    return yield* test({ fake, opened, sessionPath, logs, client }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Signs in as a person would: the app opens the address, the browser follows it back.
const signInThroughBrowser = (client: AuthClientShape, opened: Queue.Queue<string>) =>
  Effect.gen(function* () {
    const signingIn = yield* Effect.forkChild(client.signIn);
    const address = yield* Queue.take(opened);
    const page = yield* browse(address);
    yield* Fiber.join(signingIn);
    return { address, page };
  });

describe("AuthClient.signIn", () => {
  it.effect("signs in through the system's browser with PKCE S256, state and nonce", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        assert.strictEqual(yield* auth.state, "signedOut");
        const { address, page } = yield* signInThroughBrowser(auth, opened);

        const url = new URL(address);
        assert.strictEqual(url.origin + url.pathname, `${fake.issuer}/protocol/auth`);
        assert.strictEqual(url.searchParams.get("client_id"), CLIENT_ID);
        assert.strictEqual(url.searchParams.get("response_type"), "code");
        assert.strictEqual(url.searchParams.get("scope"), `openid ${DEVICE_ENTRY_SCOPE}`);
        assert.isFalse(url.searchParams.has("client_secret"));
        const [authorization] = fake.authorizations;
        const [verifier] = fake.verifiers;
        assert.isDefined(authorization);
        assert.isDefined(verifier);
        if (authorization === undefined || verifier === undefined) return;
        assert.strictEqual(authorization.method, "S256");
        assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/u);
        assert.strictEqual(authorization.challenge, yield* Effect.promise(() => sha256(verifier)));
        assert.match(authorization.state, /^[A-Za-z0-9_-]{43}$/u);
        assert.match(authorization.nonce, /^[A-Za-z0-9_-]{43}$/u);
        assert.notStrictEqual(authorization.state, authorization.nonce);
        assert.match(authorization.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[\w-]+$/u);

        assert.strictEqual(page.status, 200);
        assert.include(page.text, "Sign-in complete");
        assert.notInclude(page.text, "<script");
        assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
        assert.strictEqual(yield* auth.state, "signedIn");

        // The refresh token is on disk only sealed.
        const sealed = yield* (yield* FileSystem.FileSystem).readFileString(sessionPath);
        for (const secret of fake.secrets) assert.notInclude(sealed, secret);
        const info = yield* (yield* FileSystem.FileSystem).stat(sessionPath);
        assert.strictEqual(Number(info.mode) & 0o777, 0o600);
      }),
    ),
  );

  it.effect("shows the page in the app's language", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({ locale: "cs" });
        const { page } = yield* signInThroughBrowser(auth, opened);
        assert.include(page.text, "Přihlášení je dokončené");
      }),
    ),
  );

  it.effect("refuses a return whose state does not match and asks for no token", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        fake.settings.returnState = "not-the-state-the-app-sent";
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const page = yield* browse(yield* Queue.take(opened));
        const error = yield* Fiber.join(signingIn);
        assert.strictEqual(signInReason(error), "state-mismatch");
        assert.deepStrictEqual(fake.grants, []);
        assert.include(page.text, "Sign-in did not finish");
        assert.strictEqual(yield* auth.state, "signedOut");
      }),
    ),
  );

  it.effect("refuses an ID token whose nonce is not the one the app sent", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        fake.settings.idTokenNonce = "another-nonce";
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const page = yield* browse(yield* Queue.take(opened));
        const error = yield* Fiber.join(signingIn);
        assert.strictEqual(signInReason(error), "nonce-mismatch");
        assert.include(page.text, "Sign-in did not finish");
        assert.strictEqual(yield* auth.state, "signedOut");
      }),
    ),
  );

  it.effect("ends the sign-in when the person declines at Lazurio Auth", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        fake.settings.denyAuthorization = true;
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        yield* browse(yield* Queue.take(opened));
        const error = yield* Fiber.join(signingIn);
        assert.strictEqual(signInReason(error), "denied");
      }),
    ),
  );

  it.effect("takes a single return on its loopback address, then closes it", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(auth.signIn);
        const address = yield* Queue.take(opened);
        const redirectUri = new URL(address).searchParams.get("redirect_uri") ?? "";
        // Another path on the port is no return and does not end the sign-in.
        assert.strictEqual(yield* answers(new URL("/favicon.ico", redirectUri).toString()), 404);
        const page = yield* browse(address);
        yield* Fiber.join(signingIn);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(yield* answers(page.callback), "refused");
        assert.strictEqual(yield* answers(redirectUri), "refused");
      }),
    ),
  );

  it.effect("gives up after its timeout and closes the loopback address", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({ signInTimeout: Duration.minutes(5) });
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const address = yield* Queue.take(opened);
        const redirectUri = new URL(address).searchParams.get("redirect_uri") ?? "";
        yield* TestClock.adjust(Duration.minutes(5));
        const error = yield* Fiber.join(signingIn);
        assert.strictEqual(signInReason(error), "timed-out");
        assert.strictEqual(yield* answers(redirectUri), "refused");
        assert.strictEqual(yield* auth.state, "signedOut");
      }),
    ),
  );

  it.effect("runs one sign-in at a time", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const first = yield* Effect.forkChild(auth.signIn);
        const address = yield* Queue.take(opened);
        const second = yield* Effect.flip(auth.signIn);
        assert.strictEqual(signInReason(second), "in-progress");
        yield* browse(address);
        yield* Fiber.join(first);
        assert.strictEqual(yield* auth.state, "signedIn");
      }),
    ),
  );
});

describe("AuthClient session", () => {
  it.effect("refreshes the access token silently once it expired", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.grants, ["authorization_code"]);
        yield* TestClock.adjust(Duration.seconds(fake.settings.accessTokenSeconds));
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.grants, ["authorization_code", "refresh_token"]);
        const [first, second] = fake.handOvers;
        assert.notStrictEqual(first?.authorization, second?.authorization);
        assert.strictEqual(yield* auth.state, "signedIn");
      }),
    ),
  );

  it.effect("is signed out once Lazurio Auth refuses the refresh token", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const subscribed = yield* Deferred.make<void>();
        const states = yield* auth.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* signInThroughBrowser(auth, opened);
        fake.settings.refresh = "reject";
        yield* TestClock.adjust(Duration.seconds(fake.settings.accessTokenSeconds));
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.isTrue(isSignedOut(error));
        assert.strictEqual(yield* auth.state, "signedOut");
        assert.deepStrictEqual(
          [...(yield* Fiber.join(states))],
          ["signedOut", "signedIn", "signedOut"],
        );
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        assert.deepStrictEqual(fake.handOvers, []);
      }),
    ),
  );

  it.effect("stays signed in while Lazurio Auth cannot be reached", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        fake.settings.refresh = "unavailable";
        yield* TestClock.adjust(Duration.seconds(fake.settings.accessTokenSeconds));
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.isTrue(isUnreachable(error));
        assert.strictEqual(yield* auth.state, "signedIn");
        fake.settings.refresh = "ok";
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
      }),
    ),
  );

  it.effect("opens the sealed session at the next start", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        yield* signInThroughBrowser(yield* client(), opened);
        const later = yield* client();
        assert.strictEqual(yield* later.state, "signedIn");
        yield* later.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.grants, ["authorization_code", "refresh_token"]);
      }),
    ),
  );

  it.effect("starts signed out when the keystore does not open the session", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        yield* signInThroughBrowser(yield* client(), opened);
        const later = yield* client({
          keystore: fakeKeystore({
            open: () => {
              throw new Error("locked");
            },
          }),
        });
        assert.strictEqual(yield* later.state, "signedOut");
      }),
    ),
  );

  it.effect("keeps the refresh token only in memory without a keystore", () =>
    withHarness(({ opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({ keystore: fakeKeystore({ backend: () => "basic_text" }) });
        yield* signInThroughBrowser(auth, opened);
        assert.strictEqual(yield* auth.state, "signedIn");
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
      }),
    ),
  );

  it.effect("signs out: forgets the session, removes its file and revokes the refresh token", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.signOut;
        assert.strictEqual(yield* auth.state, "signedOut");
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        assert.strictEqual(fake.revoked.length, 1);
        assert.isTrue(fake.revoked[0]?.startsWith("refresh-SECRET-"));
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.isTrue(isSignedOut(error));
      }),
    ),
  );
});

describe("AuthClient.handOver", () => {
  it.effect("asks for a hand-over with exactly the bearer token and the origin", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        const handOver: HandOver = yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.strictEqual(Redacted.value(handOver.handOver), HAND_OVER);
        assert.notInclude(String(handOver.handOver), HAND_OVER);
        assert.notInclude(JSON.stringify(handOver), HAND_OVER);
        assert.isTrue(Duration.equals(handOver.expiresIn, Duration.seconds(60)));
        const [request] = fake.handOvers;
        assert.isDefined(request);
        if (request === undefined) return;
        assert.strictEqual(request.method, "POST");
        assert.match(request.authorization ?? "", /^Bearer access-SECRET-\d+-[\w-]+$/u);
        assert.isTrue(fake.validAccessTokens.has((request.authorization ?? "").slice(7)));
        assert.strictEqual(request.contentType, "application/json");
        assert.strictEqual(request.body, JSON.stringify({ origin: ENVIRONMENT_ORIGIN }));
      }),
    ),
  );

  it.effect("maps Lazurio Auth's refusals to typed errors", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        const reasons: Array<string> = [];
        for (const status of [403, 404, 409, 503, 500]) {
          fake.settings.handOverStatus = status;
          const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
          reasons.push(error._tag === "HandOverError" ? error.reason : error._tag);
        }
        assert.deepStrictEqual(reasons, [
          "not-permitted",
          "unknown-environment",
          "environment-state-conflict",
          "unavailable",
          "unexpected",
        ]);
      }),
    ),
  );

  it.effect("asks again once with a refreshed token when Lazurio Auth no longer takes it", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        fake.validAccessTokens.clear();
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.grants, ["authorization_code", "refresh_token"]);
        assert.strictEqual(fake.handOvers.length, 2);
      }),
    ),
  );

  it.effect("sends nothing for an origin that is not an Environment's HTTPS origin", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        const reasons: Array<string> = [];
        for (const origin of [
          "http://launchpad.alice.example-org.lazurio.io",
          "https://launchpad.alice.example-org.lazurio.io/",
          "https://launchpad.alice.example-org.lazurio.io/path",
          "https://user@launchpad.alice.example-org.lazurio.io",
          "launchpad.alice.example-org.lazurio.io",
        ]) {
          const error = yield* Effect.flip(auth.handOver(origin));
          reasons.push(error._tag === "HandOverError" ? error.reason : error._tag);
        }
        assert.deepStrictEqual(reasons, Array(5).fill("invalid-origin"));
        assert.deepStrictEqual(fake.handOvers, []);
      }),
    ),
  );

  it.effect("needs a sign-in that granted the scope lazurio-device-entry", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({ scopes: [] });
        yield* signInThroughBrowser(auth, opened);
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.strictEqual(
          error._tag === "HandOverError" ? error.reason : error._tag,
          "scope-not-granted",
        );
        assert.deepStrictEqual(fake.handOvers, []);
      }),
    ),
  );

  it.effect("needs a sign-in", () =>
    withHarness(({ client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.isTrue(isSignedOut(error));
      }),
    ),
  );
});

describe("AuthClient's secrets", () => {
  it.effect("never reach a log or an error's message", () =>
    withHarness(({ fake, opened, logs, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        yield* TestClock.adjust(Duration.seconds(fake.settings.accessTokenSeconds));
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        const messages: Array<string> = [];
        fake.settings.handOverStatus = 409;
        messages.push((yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN))).message);
        yield* auth.signOut;
        yield* signInThroughBrowser(auth, opened);
        fake.settings.refresh = "reject";
        yield* TestClock.adjust(Duration.seconds(fake.settings.accessTokenSeconds));
        const refused = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        messages.push(refused.message, String(refused), JSON.stringify(refused));

        assert.isAbove(logs.length, 0);
        assert.isAbove(fake.secrets.length, 6);
        const written = [...logs, ...messages].join("\n");
        for (const secret of fake.secrets) assert.notInclude(written, secret);
        assert.notInclude(written, HAND_OVER);
      }),
    ),
  );
});
