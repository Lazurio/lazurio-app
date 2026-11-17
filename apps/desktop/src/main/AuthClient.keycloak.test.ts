import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AuthClient, CLIENT_ID, DEVICE_ENTRY_SCOPE, HandOverError, layer } from "./AuthClient.ts";
import type { Keystore } from "./NodeKeys.ts";

// The sign-in of `lazurio-app` against a real Keycloak in a container, with the realm export in
// fixtures/. Keycloak has no device-hand-over endpoint, so the hand-over itself is tested only
// against the fake Auth (AuthClient.test.ts). Runs only with LAZURIO_KEYCLOAK_TEST=1, and only
// with the image already on the machine.

const ENABLED = process.env.LAZURIO_KEYCLOAK_TEST === "1";
const IMAGE = "quay.io/keycloak/keycloak:26.6.2";
const USERNAME = "test-person";
const PASSWORD = "keycloak-test-only-password";
const ENVIRONMENT_ORIGIN = "https://launchpad.alice.example-org.lazurio.io";

class KeycloakError extends Schema.TaggedError<KeycloakError>()("KeycloakError", {
  problem: Schema.String,
}) {}

const isHandOverError = Schema.is(HandOverError);

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", [...args], { stderr: "inherit" }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* new KeycloakError({ problem: `docker ${args[0]} exited with ${exitCode}` });
    }
    return stdout.trim();
  }).pipe(Effect.scoped);

// A Keycloak for as long as the scope lives, removed by its container's ID afterwards. It is
// ready once its log says it listens, which comes after the realm's import.
const keycloak = Effect.gen(function* () {
  const path = yield* Path.Path;
  const realm = path.join(import.meta.dirname, "fixtures", "keycloak-workspace-realm.json");
  const id = yield* Effect.acquireRelease(
    run([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--publish",
      "127.0.0.1::8080",
      "--volume",
      `${realm}:/opt/keycloak/data/import/workspace-realm.json:ro`,
      IMAGE,
      "start-dev",
      "--import-realm",
    ]),
    (id) => run(["rm", "--force", id]).pipe(Effect.ignore),
  );
  const ready = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const logs = yield* spawner.spawn(ChildProcess.make("docker", ["logs", "--follow", id]));
    return yield* logs.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.includes("Listening on:")),
      Stream.runHead,
    );
  }).pipe(Effect.scoped);
  if (Option.isNone(ready)) {
    return yield* new KeycloakError({ problem: "Keycloak stopped before it listened" });
  }
  const published = yield* run(["port", id, "8080/tcp"]);
  const port = /:(\d+)$/mu.exec(published)?.[1];
  if (port === undefined) return yield* new KeycloakError({ problem: "no published port" });
  return `http://127.0.0.1:${port}/realms/workspace`;
});

// What the app sent to Keycloak and what it answered, as a fetch that passes everything through.
interface Exchange {
  readonly url: string;
  readonly authorization: string | null;
  readonly status: number;
  readonly body: string;
}

const recordingFetch = (exchanges: Array<Exchange>): typeof globalThis.fetch => {
  const record = async (input: string | URL | Request, init?: RequestInit) => {
    // @effect-diagnostics-next-line globalFetch:off - The app's own transport, recorded.
    const response = await fetch(input, init);
    exchanges.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      status: response.status,
      body: await response.clone().text(),
    });
    return response;
  };
  return record;
};

const claimsOf = (jwt: string): Record<string, unknown> => {
  const payload = (jwt.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))),
  );
};

const audiencesOf = (claims: Record<string, unknown>): ReadonlyArray<unknown> =>
  Array.isArray(claims.aud) ? claims.aud : [claims.aud];

// A person's browser: Keycloak's login form, then the redirect back to the app's loopback address.
const signInAtKeycloak = async (address: string) => {
  const cookies = new Map<string, string>();
  const remember = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  };
  const cookie = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app.
  const login = await fetch(address, { redirect: "manual" });
  remember(login);
  const form = await login.text();
  const action = /action="([^"]*login-actions\/authenticate[^"]*)"/u.exec(form)?.[1];
  if (action === undefined) throw new Error(`no login form (HTTP ${login.status})`);
  // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app.
  const submitted = await fetch(action.replaceAll("&amp;", "&"), {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD, credentialId: "" }),
  });
  const callback = submitted.headers.get("location");
  if (callback === null) throw new Error(`no redirect after the login (HTTP ${submitted.status})`);
  // @effect-diagnostics-next-line globalFetch:off - The person's browser, outside the app.
  const page = await fetch(callback);
  return { callback, status: page.status, text: await page.text() };
};

// A keystore that seals reversibly, enough for a session's file in a temporary directory.
const keystore: Keystore = {
  available: () => true,
  backend: () => undefined,
  seal: (text) => new TextEncoder().encode(`sealed:${text}`),
  open: (sealed) => new TextDecoder().decode(sealed).slice("sealed:".length),
};

describe.runIf(ENABLED)("AuthClient against Keycloak", () => {
  it.live("signs in with PKCE, gets the device entry's audience and refreshes", () => {
    const exchanges: Array<Exchange> = [];
    return Effect.gen(function* () {
      const issuer = yield* keycloak;
      const opened = yield* Queue.unbounded<string>();
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const auth = yield* Effect.service(AuthClient).pipe(
        Effect.provide(
          layer({
            issuer,
            keystore,
            sessionPath: (yield* Path.Path).join(directory, "session.sealed"),
            allowWithoutKeystore: false,
            locale: "en",
            openBrowser: (address) => Queue.offer(opened, address).pipe(Effect.asVoid),
          }).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      );

      const signingIn = yield* Effect.forkChild(auth.signIn);
      const address = yield* Queue.take(opened);
      assert.strictEqual(new URL(address).searchParams.get("code_challenge_method"), "S256");
      const page = yield* Effect.promise(() => signInAtKeycloak(address));
      yield* Fiber.join(signingIn);
      assert.strictEqual(page.status, 200);
      assert.match(page.callback, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[\w-]+\?/u);
      assert.strictEqual(yield* auth.state, "signedIn");

      const tokenCalls = () =>
        exchanges.filter((exchange) => exchange.url.endsWith("/protocol/openid-connect/token"));
      const [signedIn] = tokenCalls();
      assert.strictEqual(signedIn?.status, 200);
      const tokens = JSON.parse(signedIn?.body ?? "{}");
      const access = claimsOf(tokens.access_token);
      assert.include(audiencesOf(access), DEVICE_ENTRY_SCOPE);
      assert.strictEqual(access.azp, CLIENT_ID);
      assert.include(String(access.scope).split(" "), DEVICE_ENTRY_SCOPE);
      assert.isString(access.sub);
      // A refresh token bound to the SSO session, not an offline one.
      assert.strictEqual(claimsOf(tokens.refresh_token).typ, "Refresh");
      assert.notInclude(String(tokens.scope).split(" "), "offline_access");

      // A clock past the access token's expiry: the hand-over refreshes it first. Keycloak has
      // no device-hand-over endpoint and answers 404, which the client maps as Auth's 404.
      const clock = yield* Clock.Clock;
      const ahead = Duration.toMillis(Duration.minutes(10));
      const error = yield* Effect.flip(auth.handOver(ENVIRONMENT_ORIGIN)).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ahead,
          currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now + ahead),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ahead) * 1_000_000n,
          currentTimeNanos: Effect.map(
            clock.currentTimeNanos,
            (now) => now + BigInt(ahead) * 1_000_000n,
          ),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        }),
      );
      assert.isTrue(isHandOverError(error));
      assert.strictEqual(isHandOverError(error) ? error.reason : "", "unknown-environment");
      const [, refreshed] = tokenCalls();
      assert.strictEqual(refreshed?.status, 200);
      const renewed = JSON.parse(refreshed?.body ?? "{}");
      assert.notStrictEqual(renewed.access_token, tokens.access_token);
      assert.include(audiencesOf(claimsOf(renewed.access_token)), DEVICE_ENTRY_SCOPE);
      const handOver = exchanges.find((exchange) => exchange.url.endsWith("/device-hand-over"));
      assert.strictEqual(handOver?.authorization, `Bearer ${renewed.access_token}`);

      yield* auth.signOut;
      assert.strictEqual(yield* auth.state, "signedOut");
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(exchanges)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
