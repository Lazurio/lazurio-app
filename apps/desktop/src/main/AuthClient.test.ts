// @effect-diagnostics-next-line nodeBuiltinImport:off - A plain HTTP server plays Lazurio Auth.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
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
  HandOverError,
  layer,
  type InvalidIssuerError,
  SignedOutError,
  SignInError,
  SignOutError,
  type AuthClientOptions,
  type AuthClientShape,
  type HandOver,
} from "./AuthClient.ts";
import { openOrOffer } from "./BrowserOpen.ts";
import type { Keystore } from "./NodeKeys.ts";

const isSignInError = Schema.is(SignInError);
const isSignedOut = Schema.is(SignedOutError);
const isUnreachable = Schema.is(AuthUnreachableError);
const isSignOutError = Schema.is(SignOutError);
const isHandOverError = Schema.is(HandOverError);
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

interface IssuedToken {
  readonly scope: string;
  readonly audiences: ReadonlyArray<string>;
}

// Codes of the route's refusals, by status, as the contract's table gives them.
const REFUSAL_CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "environment_state_conflict",
  503: "application_record_inconsistent",
};

interface FakeAuth {
  readonly issuer: string;
  readonly authorizations: Array<Authorization>;
  readonly verifiers: Array<string>;
  readonly grants: Array<string>;
  readonly handOvers: Array<HandOverRequest>;
  readonly revoked: Array<string>;
  // Every token, code and verifier the fake gave out or received, for the logs' check.
  readonly secrets: Array<string>;
  // Every access token the fake issued, with what it was issued for.
  readonly accessTokens: Map<string, IssuedToken>;
  // The `scope` of each refresh, or null for a refresh without one.
  readonly refreshScopes: Array<string | null>;
  // Each request's Authorization header and body, wherever it went.
  readonly received: Array<string>;
  settings: {
    accessTokenSeconds: number;
    // How a refresh treats its `scope`: narrowing to it, as the contract says; keeping openid
    // beside it, as Keycloak 26.6.2 did; adding another audience; or dropping it.
    scopedRefresh: "exact" | "keeps-openid" | "two-audiences" | "drops-scope";
    // Refuses this many hand-overs with 401 although their token is right.
    rejectHandOvers: number;
    // The code of a refused hand-over, instead of the table's.
    handOverCode: string | undefined;
    refresh: "ok" | "reject" | "unavailable";
    handOverStatus: number;
    // The state the redirect carries back, when it should differ from the request's.
    returnState: string | undefined;
    idTokenNonce: string | undefined;
    // The person's names the ID token carries, if any.
    idTokenNames: { readonly name?: string; readonly preferred_username?: string };
    // The ID token of a sign-in: a valid one, none, an expired one, one issued later than now,
    // or one whose authorized party is another client.
    idToken: "valid" | "missing" | "expired" | "issued-later" | "other-party";
    denyAuthorization: boolean;
    // The fake's clock in milliseconds, the test's own clock.
    now: () => number;
    // Called when a code reaches the token endpoint; the answer waits for the gate.
    onExchange: () => void;
    exchangeGate: Promise<void> | undefined;
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
    // Each live refresh token with the scope its sign-in granted.
    const refreshTokens = new Map<string, string>();
    const fake: FakeAuth = {
      issuer: "",
      authorizations: [],
      verifiers: [],
      grants: [],
      handOvers: [],
      revoked: [],
      secrets: [],
      accessTokens: new Map(),
      refreshScopes: [],
      received: [],
      settings: {
        accessTokenSeconds: 300,
        scopedRefresh: "exact",
        rejectHandOvers: 0,
        handOverCode: undefined,
        refresh: "ok",
        handOverStatus: 200,
        returnState: undefined,
        idTokenNonce: undefined,
        idTokenNames: {},
        idToken: "valid",
        denyAuthorization: false,
        now: () => 0,
        onExchange: () => {},
        exchangeGate: undefined,
      },
    };
    const idToken = (nonce: string) => {
      const now = Math.floor(fake.settings.now() / 1000);
      const kind = fake.settings.idToken;
      const issuedAt = kind === "expired" ? now - 600 : kind === "issued-later" ? now + 600 : now;
      return unsignedJwt({
        iss: fake.issuer,
        aud: kind === "other-party" ? [CLIENT_ID, "another-client"] : CLIENT_ID,
        ...(kind === "other-party" ? { azp: "another-client" } : {}),
        sub: "person-1",
        nonce: fake.settings.idTokenNonce ?? nonce,
        ...fake.settings.idTokenNames,
        iat: issuedAt,
        exp: issuedAt + 300,
      });
    };
    // `granted` stays with the refresh token; `scope` is this access token's.
    const tokens = (
      granted: string,
      scope: string,
      nonce: string | undefined,
      extraAudience = false,
    ) => {
      const audiences = [
        ...(scope.split(" ").includes(DEVICE_ENTRY_SCOPE) ? [DEVICE_ENTRY_SCOPE] : []),
        ...(extraAudience ? ["lazurio-network-directory"] : []),
      ];
      const accessToken = unsignedJwt({
        jti: next("access"),
        iss: fake.issuer,
        azp: CLIENT_ID,
        sub: "person-1",
        scope,
        ...(audiences.length === 0
          ? {}
          : { aud: audiences.length === 1 ? audiences[0] : audiences }),
      });
      const refreshToken = next("refresh");
      fake.secrets.push(accessToken, refreshToken);
      fake.accessTokens.set(accessToken, { scope, audiences });
      refreshTokens.set(refreshToken, granted);
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: fake.settings.accessTokenSeconds,
        refresh_token: refreshToken,
        refresh_expires_in: 1800,
        scope,
        ...(nonce === undefined || fake.settings.idToken === "missing"
          ? {}
          : { id_token: idToken(nonce) }),
      };
    };
    const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
      const url = new URL(request.url ?? "/", fake.issuer);
      const path = url.pathname.slice(new URL(fake.issuer).pathname.length);
      const body = request.method === "POST" ? await readBody(request) : "";
      fake.received.push(`${request.headers.authorization ?? ""}\n${url.search}\n${body}`);
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
        const form = new URLSearchParams(body);
        const grant = form.get("grant_type") ?? "";
        fake.grants.push(grant);
        if (form.get("client_id") !== CLIENT_ID || form.has("client_secret")) {
          return json(response, 401, { error: "invalid_client" });
        }
        if (grant === "authorization_code") {
          fake.settings.onExchange();
          if (fake.settings.exchangeGate !== undefined) await fake.settings.exchangeGate;
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
          return json(
            response,
            200,
            tokens(authorization.scope, authorization.scope, authorization.nonce),
          );
        }
        if (grant === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (fake.settings.refresh === "unavailable") {
            return json(response, 503, { error: "temporarily_unavailable" });
          }
          const granted = refreshTokens.get(presented);
          refreshTokens.delete(presented);
          if (fake.settings.refresh === "reject" || granted === undefined) {
            return json(response, 400, {
              error: "invalid_grant",
              error_description: "Session not active",
            });
          }
          const requested = form.get("scope");
          fake.refreshScopes.push(requested);
          // RFC 6749 §6: a refresh only narrows what the sign-in granted.
          const mode = fake.settings.scopedRefresh;
          const narrowed =
            requested === null || mode === "keeps-openid"
              ? granted
              : mode === "drops-scope"
                ? "openid"
                : requested
                    .split(" ")
                    .filter((part) => granted.split(" ").includes(part))
                    .join(" ");
          return json(
            response,
            200,
            tokens(granted, narrowed, undefined, fake.settings.scopedRefresh === "two-audiences"),
          );
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      if (request.method === "POST" && path === "/protocol/revoke") {
        const form = new URLSearchParams(body);
        fake.revoked.push(form.get("token") ?? "");
        refreshTokens.delete(form.get("token") ?? "");
        response.writeHead(200);
        return response.end();
      }
      if (path === "/lazurio-agent-entry/device-hand-over") {
        const authorization = request.headers.authorization;
        fake.handOvers.push({
          method: request.method ?? "",
          authorization,
          contentType: request.headers["content-type"],
          body,
        });
        // Check 2: exactly one audience and exactly the scope lazurio-device-entry.
        const issued = fake.accessTokens.get((authorization ?? "").replace(/^Bearer /u, ""));
        const exact =
          issued !== undefined &&
          issued.scope === DEVICE_ENTRY_SCOPE &&
          issued.audiences.length === 1 &&
          issued.audiences[0] === DEVICE_ENTRY_SCOPE;
        if (!exact || fake.settings.rejectHandOvers > 0) {
          fake.settings.rejectHandOvers = Math.max(0, fake.settings.rejectHandOvers - 1);
          return json(response, 401, { error: "unauthorized" });
        }
        const status = fake.settings.handOverStatus;
        if (status === 200) {
          fake.secrets.push(HAND_OVER);
          return json(response, 200, { handOver: HAND_OVER, expiresIn: 60 });
        }
        const code = fake.settings.handOverCode ?? REFUSAL_CODES[status];
        return json(response, status, code === undefined ? {} : { error: code });
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
// The browser's return once the app may have closed its loopback address.
const browseOrRefused = (address: string) =>
  Effect.promise(() =>
    browseOutside(address).then(
      (page) => page.text,
      () => "refused" as const,
    ),
  );

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
    // The session's file cannot be removed, as on a read-only or failing disk.
    removeFails?: boolean,
  ) => Effect.Effect<AuthClientShape, InvalidIssuerError>;
}

const withHarness = <A, E>(
  test: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fake = yield* fakeAuth;
    const clock = yield* Clock.Clock;
    fake.settings.now = () => clock.currentTimeMillisUnsafe();
    const opened = yield* Queue.unbounded<string>();
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const sessionPath = (yield* Path.Path).join(directory, "auth", "session.sealed");
    const logs: Array<string> = [];
    const capture = Logger.map(Logger.formatJson, (line) => {
      logs.push(line);
    });
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const failingRemove = FileSystem.FileSystem.of({
      ...fileSystem,
      remove: (path, options) =>
        path === sessionPath
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: path,
              }),
            )
          : fileSystem.remove(path, options),
    });
    const client = (overrides: Partial<AuthClientOptions> = {}, removeFails = false) =>
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
        Effect.provideService(FileSystem.FileSystem, removeFails ? failingRemove : fileSystem),
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
  it.effect("requires an ID token", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        fake.settings.idToken = "missing";
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const page = yield* browse(yield* Queue.take(opened));
        assert.strictEqual(signInReason(yield* Fiber.join(signingIn)), "invalid-id-token");
        assert.include(page.text, "Sign-in did not finish");
        assert.strictEqual(yield* auth.state, "signedOut");
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
      }),
    ),
  );

  it.effect("refuses an expired ID token, one issued later, and one for another party", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const reasons: Array<string> = [];
        for (const kind of ["expired", "issued-later", "other-party"] as const) {
          fake.settings.idToken = kind;
          const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
          yield* browse(yield* Queue.take(opened));
          reasons.push(signInReason(yield* Fiber.join(signingIn)));
        }
        assert.deepStrictEqual(reasons, Array(3).fill("invalid-id-token"));
        assert.strictEqual(yield* auth.state, "signedOut");
      }),
    ),
  );

  it.effect("limits the whole sign-in, a code exchange that never answers included", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const exchanging = yield* Deferred.make<void>();
        fake.settings.onExchange = () => Deferred.doneUnsafe(exchanging, Effect.void);
        fake.settings.exchangeGate = new Promise(() => {});
        const auth = yield* client({ signInTimeout: Duration.minutes(5) });
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const address = yield* Queue.take(opened);
        const redirectUri = new URL(address).searchParams.get("redirect_uri") ?? "";
        const browsing = yield* Effect.forkChild(browseOrRefused(address));
        yield* Deferred.await(exchanging);
        yield* TestClock.adjust(Duration.minutes(5));
        assert.strictEqual(signInReason(yield* Fiber.join(signingIn)), "timed-out");
        assert.include(yield* Fiber.join(browsing), "Sign-in did not finish");
        assert.strictEqual(yield* answers(redirectUri), "refused");
        // The next sign-in starts: the stuck one no longer counts as running.
        const again = yield* Effect.forkChild(auth.signIn);
        yield* Queue.take(opened);
        yield* Fiber.interrupt(again);
      }),
    ),
  );

  it.effect("limits a sign-in whose browser never opens", () =>
    withHarness(({ opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({
          signInTimeout: Duration.minutes(5),
          openBrowser: (address) => Queue.offer(opened, address).pipe(Effect.andThen(Effect.never)),
        });
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const address = yield* Queue.take(opened);
        const redirectUri = new URL(address).searchParams.get("redirect_uri") ?? "";
        yield* TestClock.adjust(Duration.minutes(5));
        assert.strictEqual(signInReason(yield* Fiber.join(signingIn)), "timed-out");
        assert.strictEqual(yield* answers(redirectUri), "refused");
      }),
    ),
  );

  it.effect("ends a sign-in still waiting for the browser when the app signs out", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const address = yield* Queue.take(opened);
        yield* auth.signOut;
        assert.strictEqual(signInReason(yield* Fiber.join(signingIn)), "cancelled");
        assert.strictEqual(yield* browseOrRefused(address), "refused");
        assert.deepStrictEqual(fake.grants, []);
        assert.strictEqual(yield* auth.state, "signedOut");
      }),
    ),
  );

  it.effect("lets a sign-out win over a sign-in whose code is being exchanged", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const exchanging = yield* Deferred.make<void>();
        let release = () => {};
        fake.settings.onExchange = () => Deferred.doneUnsafe(exchanging, Effect.void);
        fake.settings.exchangeGate = new Promise((resolve) => {
          release = resolve;
        });
        const auth = yield* client();
        const states: Array<string> = [];
        const subscribed = yield* Deferred.make<void>();
        yield* auth.changes.pipe(
          Stream.tap((state) =>
            Effect.sync(() => states.push(state)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        const signingIn = yield* Effect.forkChild(Effect.flip(auth.signIn));
        const browsing = yield* Effect.forkChild(browseOrRefused(yield* Queue.take(opened)));
        yield* Deferred.await(exchanging);
        yield* auth.signOut;
        release();
        assert.strictEqual(signInReason(yield* Fiber.join(signingIn)), "cancelled");
        assert.include(yield* Fiber.join(browsing), "Sign-in did not finish");
        assert.strictEqual(yield* auth.state, "signedOut");
        assert.deepStrictEqual(states, ["signedOut"]);
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        assert.isTrue(isSignedOut(yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN))));
      }),
    ),
  );
});

describe("AuthClient session", () => {
  it.effect("names the account from the ID token, also after a restart", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        fake.settings.idTokenNames = { name: "Bob Novák", preferred_username: "bob" };
        const auth = yield* client();
        assert.isTrue(Option.isNone(yield* auth.accountName));
        yield* signInThroughBrowser(auth, opened);
        assert.deepStrictEqual(yield* auth.accountName, Option.some("Bob Novák"));
        assert.deepStrictEqual(yield* (yield* client()).accountName, Option.some("Bob Novák"));
        yield* auth.signOut;
        assert.isTrue(Option.isNone(yield* auth.accountName));
      }),
    ),
  );

  it.effect("takes the preferred user name without a name, and none without either", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        fake.settings.idTokenNames = { preferred_username: "bob" };
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        assert.deepStrictEqual(yield* auth.accountName, Option.some("bob"));
        yield* auth.signOut;
        fake.settings.idTokenNames = {};
        yield* signInThroughBrowser(auth, opened);
        assert.isTrue(Option.isNone(yield* auth.accountName));
      }),
    ),
  );

  it.effect("revokes the refresh token at a sign-out right after a restart", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        yield* signInThroughBrowser(yield* client(), opened);
        const later = yield* client();
        assert.strictEqual(yield* later.state, "signedIn");
        yield* later.signOut;
        assert.strictEqual(fake.revoked.length, 1);
        assert.isTrue(fake.revoked[0]?.startsWith("refresh-SECRET-"));
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        assert.strictEqual(yield* (yield* client()).state, "signedOut");
      }),
    ),
  );

  it.effect("says that a sign-out does not last when the session's file stays", () =>
    withHarness(({ fake, opened, sessionPath, client }) =>
      Effect.gen(function* () {
        const auth = yield* client({}, true);
        yield* signInThroughBrowser(auth, opened);
        const error = yield* Effect.flip(auth.signOut);
        assert.isTrue(isSignOutError(error));
        assert.strictEqual(isSignOutError(error) ? error.reason : "", "session-not-removed");
        assert.notInclude(error.message, "SECRET");
        assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(sessionPath));
        // Lazurio Auth revoked the token, so the session the next start opens ends at once.
        assert.strictEqual(fake.revoked.length, 1);
        const later = yield* client();
        assert.isTrue(isSignedOut(yield* Effect.flip(later.handOver(ENVIRONMENT_ORIGIN))));
        assert.strictEqual(yield* later.state, "signedOut");
      }),
    ),
  );

  it.effect("takes a fresh token of exactly lazurio-device-entry for every hand-over", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.grants, [
          "authorization_code",
          "refresh_token",
          "refresh_token",
        ]);
        assert.deepStrictEqual(fake.refreshScopes, [DEVICE_ENTRY_SCOPE, DEVICE_ENTRY_SCOPE]);
        const [first, second] = fake.handOvers;
        assert.notStrictEqual(first?.authorization, second?.authorization);
        assert.strictEqual(yield* auth.state, "signedIn");
      }),
    ),
  );

  it.effect("keeps the rotated refresh token of a scoped refresh, sealed", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        // The fake rotates: only the newest refresh token still works, in memory and on disk.
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        yield* (yield* client()).handOver(ENVIRONMENT_ORIGIN);
        assert.strictEqual(fake.handOvers.length, 3);
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
        const token = (request.authorization ?? "").replace(/^Bearer /u, "");
        assert.deepStrictEqual(fake.accessTokens.get(token), {
          scope: DEVICE_ENTRY_SCOPE,
          audiences: [DEVICE_ENTRY_SCOPE],
        });
        assert.deepStrictEqual(fake.refreshScopes, [DEVICE_ENTRY_SCOPE]);
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
        const refusals: Array<readonly [string, string | undefined]> = [];
        for (const [status, code] of [
          [403, "forbidden"],
          [403, "agent_entry_not_member"],
          [404, undefined],
          [409, undefined],
          [503, undefined],
          [400, undefined],
          [500, undefined],
          [409, "a_code_the_contract_does_not_name"],
        ] as const) {
          fake.settings.handOverStatus = status;
          fake.settings.handOverCode = code;
          const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
          refusals.push(
            isHandOverError(error) ? [error.reason, error.code] : [error._tag, undefined],
          );
        }
        assert.deepStrictEqual(refusals, [
          ["not-permitted", "forbidden"],
          ["not-permitted", "agent_entry_not_member"],
          ["unknown-environment", "not_found"],
          ["environment-state-conflict", "environment_state_conflict"],
          ["unavailable", "application_record_inconsistent"],
          ["unexpected", "invalid_request"],
          ["unexpected", undefined],
          ["environment-state-conflict", undefined],
        ]);
      }),
    ),
  );

  it.effect("asks once more with a new scoped token after a 401, then gives up", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        fake.settings.rejectHandOvers = 1;
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        assert.deepStrictEqual(fake.refreshScopes, [DEVICE_ENTRY_SCOPE, DEVICE_ENTRY_SCOPE]);
        assert.strictEqual(fake.handOvers.length, 2);
        assert.notStrictEqual(fake.handOvers[0]?.authorization, fake.handOvers[1]?.authorization);

        fake.settings.rejectHandOvers = 5;
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.deepStrictEqual(isHandOverError(error) ? [error.reason, error.code] : [], [
          "unauthorized",
          "unauthorized",
        ]);
        assert.strictEqual(fake.handOvers.length, 4);
        assert.strictEqual(fake.refreshScopes.length, 4);
        assert.strictEqual(yield* auth.state, "signedIn");
      }),
    ),
  );

  it.effect("uses a token of exactly lazurio-device-entry for one hand-over and nowhere else", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        yield* auth.signOut;
        const scoped = [...fake.accessTokens].filter(
          ([, issued]) => issued.scope === DEVICE_ENTRY_SCOPE,
        );
        assert.strictEqual(scoped.length, 2);
        for (const [token] of scoped) {
          const uses = fake.received.filter((request) => request.includes(token));
          assert.strictEqual(uses.length, 1);
          assert.isTrue(
            fake.handOvers.some((request) => request.authorization === `Bearer ${token}`),
          );
        }
        // The sign-in's own access token, with openid, never goes to the hand-over.
        const general = [...fake.accessTokens].filter(
          ([, issued]) => issued.scope !== DEVICE_ENTRY_SCOPE,
        );
        for (const [token] of general) {
          assert.isFalse(fake.received.some((request) => request.includes(token)));
        }
      }),
    ),
  );

  it.effect("leaves openid beside the scope to Auth, which refuses it with 401", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        fake.settings.scopedRefresh = "keeps-openid";
        const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
        assert.deepStrictEqual(
          isHandOverError(error) ? [error.reason, error.status, error.code] : [error._tag],
          ["unauthorized", 401, "unauthorized"],
        );
        assert.deepStrictEqual(fake.refreshScopes, [DEVICE_ENTRY_SCOPE, DEVICE_ENTRY_SCOPE]);
        assert.strictEqual(fake.handOvers.length, 2);
        for (const request of fake.handOvers) {
          const token = (request.authorization ?? "").replace(/^Bearer /u, "");
          assert.deepStrictEqual(fake.accessTokens.get(token), {
            scope: `openid ${DEVICE_ENTRY_SCOPE}`,
            audiences: [DEVICE_ENTRY_SCOPE],
          });
        }
        assert.strictEqual(yield* auth.state, "signedIn");
      }),
    ),
  );

  it.effect("sends no token with another audience or without the scope", () =>
    withHarness(({ fake, opened, client }) =>
      Effect.gen(function* () {
        const auth = yield* client();
        yield* signInThroughBrowser(auth, opened);
        const reasons: Array<string> = [];
        for (const mode of ["two-audiences", "drops-scope"] as const) {
          fake.settings.scopedRefresh = mode;
          const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN));
          reasons.push(isHandOverError(error) ? error.reason : error._tag);
        }
        assert.deepStrictEqual(reasons, ["scope-not-granted", "scope-not-granted"]);
        assert.deepStrictEqual(fake.handOvers, []);
        assert.strictEqual(yield* auth.state, "signedIn");
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

describe("AuthClient.signIn when the system's browser does not open", () => {
  it.effect("keeps waiting while the person opens the offered address themselves", () =>
    withHarness(({ fake, client }) =>
      Effect.gen(function* () {
        const offered = yield* Deferred.make<string>();
        const auth = yield* client({
          // The system cannot open the address; the app offers it to copy (BrowserOpen).
          openBrowser: openOrOffer(
            () => Promise.reject(new Error("Failed to open (0x483)")),
            (address) => {
              Deferred.doneUnsafe(offered, Effect.succeed(address));
            },
          ),
        });
        const signingIn = yield* Effect.forkChild(auth.signIn);
        // The person copies the address and opens it in a browser of their own, later.
        const address = yield* Deferred.await(offered);
        const page = yield* browse(address);
        assert.strictEqual(page.status, 200);
        yield* Fiber.join(signingIn);
        assert.strictEqual(yield* auth.state, "signedIn");
        assert.deepStrictEqual(fake.grants, ["authorization_code"]);
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
        yield* auth.handOver(ENVIRONMENT_ORIGIN);
        const messages: Array<string> = [];
        fake.settings.handOverStatus = 409;
        messages.push((yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN))).message);
        yield* auth.signOut;
        yield* signInThroughBrowser(auth, opened);
        fake.settings.refresh = "reject";
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
