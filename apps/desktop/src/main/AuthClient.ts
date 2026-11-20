// @effect-diagnostics-next-line nodeBuiltinImport:off - RFC 8252's loopback listener, closed after one request.
import * as NodeHttp from "node:http";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { Locale } from "../ui/messages.ts";
import { LAZURIO_AUTH_ISSUER } from "./Navigation.ts";
import { NO_KEYSTORE, type Keystore } from "./NodeKeys.ts";
import { SIGN_IN_PAGE_HEADERS, signInPage, type SignInOutcome } from "./SignInPage.ts";

// The app's own sign-in with Lazurio Auth: the public client `lazurio-app`, Authorization Code
// with PKCE S256 in the system's browser and a one-time loopback return (RFC 8252). The refresh
// token stays in the main process, sealed by the system's keystore (ADR 0003); the access token
// lives in memory only. Neither ever leaves this module, and neither reaches a log or an error.

export const CLIENT_ID = "lazurio-app";
// The optional scope whose access token Lazurio Auth takes for an Environment's hand-over.
export const DEVICE_ENTRY_SCOPE = "lazurio-device-entry";

const DEFAULT_SIGN_IN_TIMEOUT = Duration.minutes(5);
// How far the computer's clock may differ from Lazurio Auth's for an ID token's times.
const CLOCK_SKEW_SECONDS = 60;
const REVOCATION_WITHIN = Duration.seconds(5);
const HAND_OVER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type AuthState = "signedOut" | "signedIn";

export class InvalidIssuerError extends Schema.TaggedError<InvalidIssuerError>()(
  "InvalidIssuerError",
  { problem: Schema.String },
) {
  override get message(): string {
    return `sign-in issuer: ${this.problem}`;
  }
}

export class SignInError extends Schema.TaggedError<SignInError>()("SignInError", {
  // in-progress: another sign-in runs; cancelled: a sign-out ended it; timed-out: the whole
  // sign-in took too long; the others: the browser, the return or the tokens failed.
  reason: Schema.Literals([
    "in-progress",
    "cancelled",
    "browser",
    "loopback",
    "timed-out",
    "denied",
    "state-mismatch",
    "invalid-callback",
    "token-refused",
    "invalid-tokens",
    "invalid-id-token",
    "nonce-mismatch",
  ]),
}) {
  override get message(): string {
    return `sign-in: ${this.reason}`;
  }
}

// Lazurio Auth did not answer as it should: no connection, a server error or an answer that is no
// discovery document or token response. A session stays as it was.
export class AuthUnreachableError extends Schema.TaggedError<AuthUnreachableError>()(
  "AuthUnreachableError",
  {
    operation: Schema.Literals(["discovery", "sign-in", "refresh", "hand-over"]),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Lazurio Auth unreachable for ${this.operation}${status}`;
  }
}

// No session: never signed in, signed out, or Lazurio Auth refused the refresh token because the
// person's session there ended. A new sign-in is needed.
export class SignedOutError extends Schema.TaggedError<SignedOutError>()("SignedOutError", {}) {
  override get message(): string {
    return "signed out of Lazurio Auth";
  }
}

// A sign-out that ended the session in the app but not on disk: the next start opens it again.
export class SignOutError extends Schema.TaggedError<SignOutError>()("SignOutError", {
  reason: Schema.Literals(["session-not-removed"]),
}) {
  override get message(): string {
    return "sign-out: the sealed session could not be removed, so the next start opens it again";
  }
}

// The codes of the route's `{"error": "<code>"}` (Auth, docs/device-channel-entry.md).
const HandOverRefusalCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "not_found",
  "forbidden",
  "agent_entry_not_member",
  "environment_state_conflict",
  "application_record_inconsistent",
]);

export class HandOverError extends Schema.TaggedError<HandOverError>()("HandOverError", {
  // invalid-origin: no `https://<host>` origin; scope-not-granted: no token with the scope
  // lazurio-device-entry and its one audience; then Auth's 404, 403, 409, 503 and a second 401.
  reason: Schema.Literals([
    "invalid-origin",
    "scope-not-granted",
    "unknown-environment",
    "not-permitted",
    "environment-state-conflict",
    "unavailable",
    "unauthorized",
    "unexpected",
  ]),
  status: Schema.optional(Schema.Number),
  // Auth's own code of a refusal, for a more precise reason to show.
  code: Schema.optional(HandOverRefusalCode),
}) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    const code = this.code === undefined ? "" : `, ${this.code}`;
    return `device hand-over: ${this.reason}${status}${code}`;
  }
}

// A one-time hand-over for one Environment. Only the Device helper's channel may read it.
export interface HandOver {
  readonly handOver: Redacted.Redacted<string>;
  readonly expiresIn: Duration.Duration;
}

export interface AuthClientOptions {
  // Tests only: another issuer, `https://<host>` and the realm's path without a trailing slash,
  // or a loopback one over plain HTTP. The app always uses LAZURIO_AUTH_ISSUER (docs/adr/0008).
  readonly issuer?: string;
  readonly keystore: Keystore;
  // Where the sealed session lives, in the app's userData.
  readonly sessionPath: string;
  // Development builds only: Linux without a keystore seals with Chromium's fixed password.
  // Otherwise a session without a keystore lives in memory only.
  readonly allowWithoutKeystore: boolean;
  // Opens the address in the system's browser (shell.openExternal), never in a view of the app.
  readonly openBrowser: (address: string) => Effect.Effect<void, SignInError>;
  // The language of the page the browser shows after the return.
  readonly locale: Locale;
  // Optional scopes a sign-in asks for besides `openid`; lazurio-device-entry by default.
  readonly scopes?: ReadonlyArray<string>;
  readonly signInTimeout?: Duration.Input;
}

export interface AuthClientShape {
  readonly state: Effect.Effect<AuthState>;
  // The signed-in person's name from the sign-in's ID token (`name`, else `preferred_username`),
  // when it carried one; none when signed out.
  readonly accountName: Effect.Effect<Option.Option<string>>;
  // The current state, then every change.
  readonly changes: Stream.Stream<AuthState>;
  // One at a time, within its time limit; a sign-out or an interruption cancels it.
  readonly signIn: Effect.Effect<void, SignInError | AuthUnreachableError>;
  // Ends the session in the app and revokes it at Lazurio Auth. Fails when the sealed session
  // stays on disk, since the next start would open it again.
  readonly signOut: Effect.Effect<void, SignOutError>;
  // `origin` is `https://<the host of the Environment's Launchpad>`.
  readonly handOver: (
    origin: string,
  ) => Effect.Effect<HandOver, HandOverError | SignedOutError | AuthUnreachableError>;
}

export class AuthClient extends Context.Service<AuthClient, AuthClientShape>()(
  "@lazurio/app-desktop/main/AuthClient",
) {}

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  revocation_endpoint: Schema.optional(Schema.String),
});
const decodeDiscovery = Schema.decodeUnknownOption(Discovery);

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
type TokenResponse = typeof TokenResponse.Type;
const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponse);

const IdTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  azp: Schema.optional(Schema.String),
  nonce: Schema.optional(Schema.String),
  exp: Schema.Number,
  iat: Schema.Number,
  name: Schema.optional(Schema.String),
  preferred_username: Schema.optional(Schema.String),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

const HandOverResponse = Schema.Struct({ handOver: Schema.String, expiresIn: Schema.Number });
const decodeHandOverResponse = Schema.decodeUnknownOption(HandOverResponse);
const decodeHandOverRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ error: HandOverRefusalCode }),
);

// An access token's audiences, read only to check what Lazurio Auth answered; the token is
// verified by Auth, which takes it.
const AccessTokenClaims = Schema.Struct({
  aud: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const decodeAccessTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccessTokenClaims),
);

const SessionRecord = Schema.Struct({
  issuer: Schema.String,
  clientId: Schema.String,
  refreshToken: Schema.String,
  scope: Schema.String,
  // The person's name for the window, sealed with the session; sessions before it have none.
  name: Schema.optional(Schema.String),
});
const encodeSessionRecord = Schema.encodeOption(Schema.fromJsonString(SessionRecord));
const decodeSessionRecord = Schema.decodeUnknownOption(Schema.fromJsonString(SessionRecord));

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

const issuerOf = (address: string): Result.Result<string, InvalidIssuerError> => {
  const invalid = (problem: string) => Result.fail(new InvalidIssuerError({ problem }));
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return invalid("not an address");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return invalid("credentials, a query or a fragment");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return invalid("not HTTPS");
  }
  return Result.succeed(`${url.origin}${url.pathname.replace(/\/+$/u, "")}`);
};

// An Environment's origin exactly: `https://<host>` with no credentials, path or trailing slash.
const isEnvironmentOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.username === "" && url.origin === origin;
  } catch {
    return false;
  }
};

const randomToken = (): string => Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)));

const s256 = (verifier: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).pipe(
    Effect.map((digest) => Base64Url.encode(new Uint8Array(digest))),
  );

const scopesOf = (scope: string): ReadonlySet<string> =>
  new Set(scope.split(" ").filter((part) => part !== ""));

// The ID token's claims, read without checking its signature: it comes straight from the token
// endpoint over TLS in answer to this sign-in's code and verifier (OIDC Core 3.1.3.7), and the
// app uses it only to match the nonce, never as proof towards anyone else.
const idTokenClaims = (idToken: string) => {
  const payload = idToken.split(".")[1] ?? "";
  return Result.match(Base64Url.decodeString(payload), {
    onFailure: () => Option.none(),
    onSuccess: decodeIdTokenClaims,
  });
};

interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly revocation: string | undefined;
}

interface Session {
  readonly refreshToken: Redacted.Redacted<string>;
  readonly scope: string;
  readonly name?: string;
}

// The return to the loopback address, and its answer, which only the first call sends.
interface LoopbackReturn {
  readonly url: URL;
  readonly respond: (outcome: SignInOutcome) => Effect.Effect<void>;
}

const respondOnce = (response: NodeHttp.ServerResponse, locale: Locale) => {
  let sent = false;
  return (outcome: SignInOutcome) =>
    Effect.callback<void>((resume) => {
      if (sent || response.writableEnded) return resume(Effect.void);
      sent = true;
      response.writeHead(outcome === "signed-in" ? 200 : 400, SIGN_IN_PAGE_HEADERS);
      response.end(signInPage(locale, outcome), () => resume(Effect.void));
    });
};

// A listener on 127.0.0.1 at a port the system picks, for as long as the scope lives. It takes
// the first GET of the return path and answers every other request with 404. Closing it answers a
// return still waiting, then drops every connection.
const loopback = Effect.fn("AuthClient.loopback")(function* (returnPath: string, locale: Locale) {
  const returned = yield* Deferred.make<LoopbackReturn>();
  let pending: Option.Option<LoopbackReturn> = Option.none();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, SignInError>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "GET" || url.pathname !== returnPath || Option.isSome(pending)) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const taken: LoopbackReturn = { url, respond: respondOnce(response, locale) };
        pending = Option.some(taken);
        Deferred.doneUnsafe(returned, Effect.succeed(taken));
      });
      server.once("error", () => resume(Effect.fail(new SignInError({ reason: "loopback" }))));
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.gen(function* () {
        if (Option.isSome(pending)) yield* pending.value.respond("failed");
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeAllConnections();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* new SignInError({ reason: "loopback" });
  }
  return { port: address.port, returned: Deferred.await(returned) };
});

export const layer = (options: AuthClientOptions) =>
  Layer.effect(
    AuthClient,
    Effect.gen(function* () {
      const issuer = yield* Effect.fromResult(issuerOf(options.issuer ?? LAZURIO_AUTH_ISSUER));
      const http = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const requestedScopes = options.scopes ?? [DEVICE_ENTRY_SCOPE];
      const signInTimeout = Duration.fromInputUnsafe(
        options.signInTimeout ?? DEFAULT_SIGN_IN_TIMEOUT,
      );
      const issuerOrigin = new URL(issuer).origin;

      // A session survives a restart only where the system's keystore seals it (ADR 0003).
      const backend = options.keystore.backend();
      const persists =
        options.keystore.available() &&
        (backend === undefined || !NO_KEYSTORE.has(backend) || options.allowWithoutKeystore);
      if (!persists) {
        yield* Effect.logWarning("auth: no keystore, so a session lasts only while the app runs");
      }

      // Lazurio Auth sees no trace headers, and no span records a request of this module.
      const send = (request: HttpClientRequest.HttpClientRequest) =>
        http.execute(request).pipe(
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        );
      const jsonOf = (response: HttpClientResponse.HttpClientResponse) =>
        response.json.pipe(Effect.orElseSucceed(() => null));

      let endpoints: Option.Option<Endpoints> = Option.none();
      const discover = Effect.fn("AuthClient.discover")(function* () {
        if (Option.isSome(endpoints)) return endpoints.value;
        const unreachable = (status?: number) =>
          new AuthUnreachableError({ operation: "discovery", status });
        const response = yield* send(
          HttpClientRequest.get(`${issuer}/.well-known/openid-configuration`),
        ).pipe(Effect.mapError(() => unreachable()));
        if (response.status !== 200) return yield* unreachable(response.status);
        const document = decodeDiscovery(yield* jsonOf(response));
        // Every endpoint must be the issuer's own (OIDC Discovery 4.3).
        const sameOrigin = (address: string | undefined) => {
          try {
            return address === undefined || new URL(address).origin === issuerOrigin;
          } catch {
            return false;
          }
        };
        if (
          Option.isNone(document) ||
          document.value.issuer !== issuer ||
          !sameOrigin(document.value.authorization_endpoint) ||
          !sameOrigin(document.value.token_endpoint) ||
          !sameOrigin(document.value.revocation_endpoint)
        ) {
          return yield* unreachable(200);
        }
        const found: Endpoints = {
          authorization: document.value.authorization_endpoint,
          token: document.value.token_endpoint,
          revocation: document.value.revocation_endpoint,
        };
        endpoints = Option.some(found);
        return found;
      });

      const state = yield* SubscriptionRef.make<AuthState>("signedOut");
      let session: Option.Option<Session> = Option.none();
      // Refreshes and sign-outs one at a time, so a rotated refresh token is never used twice.
      const lock = yield* Semaphore.make(1);

      const openSession = Effect.gen(function* () {
        if (!persists) return Option.none<Session>();
        const exists = yield* fileSystem
          .exists(options.sessionPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) return Option.none<Session>();
        const opened = yield* fileSystem.readFile(options.sessionPath).pipe(
          Effect.flatMap((sealed) =>
            Effect.try({ try: () => options.keystore.open(sealed), catch: () => "not opened" }),
          ),
          Effect.map(decodeSessionRecord),
          Effect.orElseSucceed(() => Option.none<typeof SessionRecord.Type>()),
        );
        if (
          Option.isNone(opened) ||
          opened.value.issuer !== issuer ||
          opened.value.clientId !== CLIENT_ID
        ) {
          yield* Effect.logWarning(
            "auth: the sealed session does not open, so the app is signed out",
          );
          return Option.none<Session>();
        }
        return Option.some<Session>({
          refreshToken: Redacted.make(opened.value.refreshToken),
          scope: opened.value.scope,
          ...(opened.value.name === undefined ? {} : { name: opened.value.name }),
        });
      });

      const saveSession = Effect.fn("AuthClient.saveSession")(
        function* (saved: Session) {
          if (!persists) return;
          const text = encodeSessionRecord({
            issuer,
            clientId: CLIENT_ID,
            refreshToken: Redacted.value(saved.refreshToken),
            scope: saved.scope,
            ...(saved.name === undefined ? {} : { name: saved.name }),
          });
          if (Option.isNone(text)) return yield* Effect.fail("not encoded");
          const sealed = yield* Effect.try({
            try: () => options.keystore.seal(text.value),
            catch: () => "not sealed",
          });
          const next = `${options.sessionPath}.new`;
          yield* fileSystem.makeDirectory(path.dirname(options.sessionPath), { recursive: true });
          yield* fileSystem.remove(next, { force: true });
          yield* fileSystem.writeFile(next, sealed, { mode: 0o600 });
          yield* fileSystem.rename(next, options.sessionPath);
        },
        Effect.catch(() =>
          Effect.logWarning(
            "auth: the session could not be saved, so it lasts only while the app runs",
          ),
        ),
      );

      // Whether no sealed session is left on disk.
      const removeSession = fileSystem.remove(options.sessionPath, { force: true }).pipe(
        Effect.as(true),
        Effect.catch(() =>
          Effect.logWarning("auth: the sealed session could not be removed").pipe(Effect.as(false)),
        ),
      );

      // Ends the session in memory and on disk. Callers hold the lock.
      const endSession = Effect.gen(function* () {
        const ended = session;
        session = Option.none();
        const removed = yield* removeSession;
        if (Option.isSome(ended)) yield* SubscriptionRef.set(state, "signedOut");
        return { ended, removed };
      });

      // A refresh for an access token of exactly `scope`, which only narrows what the sign-in
      // granted (RFC 6749 §6). The token serves one call and is never kept: every purpose asks
      // for its own. A rotated refresh token is kept and sealed. Callers hold the lock.
      const refresh = Effect.fn("AuthClient.refresh")(function* (current: Session, scope: string) {
        const unreachable = (status?: number) =>
          new AuthUnreachableError({ operation: "refresh", status });
        const found = yield* discover().pipe(Effect.mapError(() => unreachable()));
        const response = yield* send(
          HttpClientRequest.post(found.token).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "refresh_token",
              refresh_token: Redacted.value(current.refreshToken),
              client_id: CLIENT_ID,
              scope,
            }),
          ),
        ).pipe(Effect.mapError(() => unreachable()));
        if (response.status === 400 || response.status === 401) {
          yield* Effect.logWarning("auth: Lazurio Auth refused the refresh token, so signed out");
          yield* endSession;
          return yield* new SignedOutError();
        }
        if (response.status !== 200) return yield* unreachable(response.status);
        const tokens = decodeTokenResponse(yield* jsonOf(response));
        if (Option.isNone(tokens) || tokens.value.token_type.toLowerCase() !== "bearer") {
          return yield* unreachable(200);
        }
        const rotated = tokens.value.refresh_token;
        if (rotated !== undefined) {
          const next: Session = { ...current, refreshToken: Redacted.make(rotated) };
          session = Option.some(next);
          yield* saveSession(next);
        }
        const claims = decodeAccessTokenClaims(
          Result.getOrElse(
            Base64Url.decodeString(tokens.value.access_token.split(".")[1] ?? ""),
            () => "",
          ),
        );
        const audience = Option.map(claims, ({ aud }) =>
          aud === undefined ? [] : typeof aud === "string" ? [aud] : aud,
        );
        yield* Effect.logDebug("auth: scoped access token refreshed");
        return {
          token: Redacted.make(tokens.value.access_token),
          scope: tokens.value.scope,
          audiences: Option.getOrElse(audience, () => []),
        };
      });

      // A token for one call of device-hand-over: the scope lazurio-device-entry and its one
      // audience. Whether the scope is exactly that one (route check 2) is Auth's to judge; the
      // pinned Keycloak 26.7.3 answers exactly it, and an older one that kept openid gets Auth's
      // 401.
      const deviceEntryToken = lock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isNone(session)) return yield* new SignedOutError();
          const scoped = yield* refresh(session.value, DEVICE_ENTRY_SCOPE);
          if (
            !scopesOf(scoped.scope ?? "").has(DEVICE_ENTRY_SCOPE) ||
            scoped.audiences.length !== 1 ||
            scoped.audiences[0] !== DEVICE_ENTRY_SCOPE
          ) {
            return yield* new HandOverError({ reason: "scope-not-granted" });
          }
          return scoped.token;
        }),
      );

      const exchange = Effect.fn("AuthClient.exchange")(function* (
        found: Endpoints,
        code: string,
        redirectUri: string,
        verifier: string,
        nonce: string,
      ) {
        const response = yield* send(
          HttpClientRequest.post(found.token).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: CLIENT_ID,
              code_verifier: verifier,
            }),
          ),
        ).pipe(Effect.mapError(() => new AuthUnreachableError({ operation: "sign-in" })));
        if (response.status === 400 || response.status === 401) {
          return yield* new SignInError({ reason: "token-refused" });
        }
        if (response.status !== 200) {
          return yield* new AuthUnreachableError({ operation: "sign-in", status: response.status });
        }
        const tokens = decodeTokenResponse(yield* jsonOf(response));
        if (
          Option.isNone(tokens) ||
          tokens.value.refresh_token === undefined ||
          tokens.value.token_type.toLowerCase() !== "bearer"
        ) {
          return yield* new SignInError({ reason: "invalid-tokens" });
        }
        // OIDC Core 3.1.3.7: the sign-in counts only with this sign-in's ID token.
        const invalidIdToken = new SignInError({ reason: "invalid-id-token" });
        if (tokens.value.id_token === undefined) return yield* invalidIdToken;
        const claims = idTokenClaims(tokens.value.id_token);
        if (Option.isNone(claims)) return yield* invalidIdToken;
        const { iss, aud, azp, exp, iat } = claims.value;
        const audiences = typeof aud === "string" ? [aud] : aud;
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (
          iss !== issuer ||
          !audiences.includes(CLIENT_ID) ||
          ((audiences.length > 1 || azp !== undefined) && azp !== CLIENT_ID) ||
          exp + CLOCK_SKEW_SECONDS <= now ||
          iat - CLOCK_SKEW_SECONDS > now
        ) {
          return yield* invalidIdToken;
        }
        if (claims.value.nonce !== nonce) {
          return yield* new SignInError({ reason: "nonce-mismatch" });
        }
        const name = claims.value.name ?? claims.value.preferred_username;
        return { tokens: tokens.value, refreshToken: tokens.value.refresh_token, name };
      });

      let signingIn = false;
      // Each sign-out starts a new generation; a sign-in commits only in the one it began in.
      let generation = 0;
      let cancelSignIn: Option.Option<Deferred.Deferred<void>> = Option.none();

      const attempt = Effect.fn("AuthClient.attempt")(function* (started: number) {
        const found = yield* discover();
        const verifier = randomToken();
        const expectedState = randomToken();
        const nonce = randomToken();
        const returnPath = `/callback/${randomToken()}`;
        const listener = yield* loopback(returnPath, options.locale);
        const redirectUri = `http://127.0.0.1:${listener.port}${returnPath}`;

        const authorize = new URL(found.authorization);
        for (const [name, value] of Object.entries({
          response_type: "code",
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          scope: ["openid", ...requestedScopes].join(" "),
          state: expectedState,
          nonce,
          code_challenge: yield* s256(verifier),
          code_challenge_method: "S256",
        })) {
          authorize.searchParams.set(name, value);
        }
        yield* options.openBrowser(authorize.toString());

        const back = yield* listener.returned;
        const query = back.url.searchParams;
        if (query.get("state") !== expectedState) {
          return yield* new SignInError({ reason: "state-mismatch" });
        }
        // RFC 9207: a return that names an issuer must name this one.
        if (query.has("iss") && query.get("iss") !== issuer) {
          return yield* new SignInError({ reason: "invalid-callback" });
        }
        if (query.has("error")) return yield* new SignInError({ reason: "denied" });
        const code = query.get("code");
        if (code === null || code === "") {
          return yield* new SignInError({ reason: "invalid-callback" });
        }

        const { tokens, refreshToken, name } = yield* exchange(
          found,
          code,
          redirectUri,
          verifier,
          nonce,
        );
        // The sign-in's own access token is not kept: each call asks for a token of its scope.
        const next: Session = {
          refreshToken: Redacted.make(refreshToken),
          scope: tokens.scope ?? ["openid", ...requestedScopes].join(" "),
          ...(name === undefined || name.trim() === "" ? {} : { name: name.trim() }),
        };
        // A sign-out since the start wins, whenever it came.
        yield* lock.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (generation !== started) return yield* new SignInError({ reason: "cancelled" });
              session = Option.some(next);
              yield* saveSession(next);
              yield* SubscriptionRef.set(state, "signedIn");
            }),
          ),
        );
        yield* back.respond("signed-in");
        yield* Effect.logInfo("auth: signed in");
      }, Effect.scoped);

      // The time limit holds for the whole sign-in, from discovery through the code's exchange,
      // and a sign-out ends it at once; either way its loopback address closes.
      const signIn = Effect.gen(function* () {
        const started = generation;
        const cancelled = yield* Deferred.make<void>();
        cancelSignIn = Option.some(cancelled);
        yield* attempt(started).pipe(
          Effect.timeoutOrElse({
            duration: signInTimeout,
            orElse: () => Effect.fail(new SignInError({ reason: "timed-out" })),
          }),
          Effect.raceFirst(
            Deferred.await(cancelled).pipe(
              Effect.andThen(Effect.fail(new SignInError({ reason: "cancelled" }))),
            ),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            cancelSignIn = Option.none();
          }),
        ),
        Effect.withSpan("AuthClient.signIn"),
      );

      const opened = yield* openSession;
      if (Option.isSome(opened)) {
        session = opened;
        yield* SubscriptionRef.set(state, "signedIn");
      }

      const handOverWith = Effect.fn("AuthClient.handOverWith")(function* (
        origin: string,
        token: Redacted.Redacted<string>,
      ) {
        const response = yield* send(
          HttpClientRequest.post(`${issuer}/lazurio-agent-entry/device-hand-over`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({ origin }),
          ),
        ).pipe(Effect.mapError(() => new AuthUnreachableError({ operation: "hand-over" })));
        return response;
      });

      return AuthClient.of({
        state: SubscriptionRef.get(state),
        accountName: Effect.sync(() =>
          Option.flatMap(session, (current) => Option.fromNullishOr(current.name)),
        ),
        changes: SubscriptionRef.changes(state),
        signIn: Effect.suspend(() => {
          if (signingIn) return Effect.fail(new SignInError({ reason: "in-progress" }));
          signingIn = true;
          return signIn.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                signingIn = false;
              }),
            ),
          );
        }),
        signOut: Effect.gen(function* () {
          const { ended, removed } = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              generation += 1;
              if (Option.isSome(cancelSignIn))
                yield* Deferred.succeed(cancelSignIn.value, undefined);
              return yield* endSession;
            }),
          );
          if (Option.isSome(ended)) {
            yield* Effect.logInfo("auth: signed out");
            // Best effort: the session at Lazurio Auth ends on its own when this fails. After a
            // restart the app has not discovered the endpoints yet, so it does here.
            yield* Effect.gen(function* () {
              const found = yield* discover();
              if (found.revocation === undefined) return;
              yield* send(
                HttpClientRequest.post(found.revocation).pipe(
                  HttpClientRequest.bodyUrlParams({
                    token: Redacted.value(ended.value.refreshToken),
                    token_type_hint: "refresh_token",
                    client_id: CLIENT_ID,
                  }),
                ),
              );
            }).pipe(Effect.timeoutOption(REVOCATION_WITHIN), Effect.ignore);
          }
          if (!removed) return yield* new SignOutError({ reason: "session-not-removed" });
        }).pipe(Effect.withSpan("AuthClient.signOut")),
        handOver: Effect.fn("AuthClient.handOver")(function* (origin: string) {
          if (!isEnvironmentOrigin(origin)) {
            return yield* new HandOverError({ reason: "invalid-origin" });
          }
          if (Option.isNone(session)) return yield* new SignedOutError();
          if (!scopesOf(session.value.scope).has(DEVICE_ENTRY_SCOPE)) {
            return yield* new HandOverError({ reason: "scope-not-granted" });
          }
          // A fresh token right before each call, and once more after a 401.
          const ask = deviceEntryToken.pipe(Effect.flatMap((token) => handOverWith(origin, token)));
          let response = yield* ask;
          if (response.status === 401) response = yield* ask;
          const code =
            response.status === 200
              ? undefined
              : Option.getOrUndefined(
                  Option.map(decodeHandOverRefusal(yield* jsonOf(response)), ({ error }) => error),
                );
          const refused = (reason: HandOverError["reason"]) =>
            new HandOverError({ reason, status: response.status, code });
          switch (response.status) {
            case 200:
              break;
            case 401:
              return yield* refused("unauthorized");
            case 403:
              return yield* refused("not-permitted");
            case 404:
              return yield* refused("unknown-environment");
            case 409:
              return yield* refused("environment-state-conflict");
            case 503:
              return yield* refused("unavailable");
            default:
              return yield* refused("unexpected");
          }
          const answer = decodeHandOverResponse(yield* jsonOf(response));
          if (
            Option.isNone(answer) ||
            !HAND_OVER_PATTERN.test(answer.value.handOver) ||
            !(answer.value.expiresIn > 0)
          ) {
            return yield* refused("unexpected");
          }
          yield* Effect.logInfo("auth: device hand-over issued");
          return {
            handOver: Redacted.make(answer.value.handOver, { label: "handOver" }),
            expiresIn: Duration.seconds(answer.value.expiresIn),
          } satisfies HandOver;
        }),
      });
    }),
  );
