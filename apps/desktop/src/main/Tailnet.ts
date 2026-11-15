import { create } from "@bufbuild/protobuf";
import {
  StartNodeSchema,
  type NodeState,
  type ProxyEndpoint,
} from "@lazurio/app-contracts/tailnet/v1";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import type { TailnetStatus } from "../shared/bridge.ts";
import type { NavigationObserver } from "./Hardening.ts";
import type { HelperConnection } from "./Helpers.ts";
import type { NodeKeyError } from "./NodeKeys.ts";

// The app's side of the tailnet helper (decision 0248): it starts one node per tailnet, gives the
// remote views a PAC script that sends only the tailnets' names to the helper's proxy, answers the
// proxy's challenge with its credentials, and opens a node's sign-in in the system's browser.

const TailnetConfig = Schema.Struct({
  tailnet: Schema.String,
  controlUrl: Schema.String,
  hostname: Schema.String,
  domains: Schema.Array(Schema.String),
});
type TailnetConfig = typeof TailnetConfig.Type;

export const decodeTailnets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(TailnetConfig)),
);

class TailnetError extends Schema.TaggedError<TailnetError>()("TailnetError", {
  problem: Schema.String,
}) {
  override get message(): string {
    return `tailnet: ${this.problem}`;
  }
}

const normalizeDomain = (domain: string): string => domain.toLowerCase().replace(/^\.+|\.+$/gu, "");

// A PAC script that sends the tailnets' names to the proxy and every other name directly.
export const pacScript = (
  domains: ReadonlyArray<string>,
  proxy: { readonly host: string; readonly port: number },
): string => {
  const suffixes = domains.map(normalizeDomain).filter((domain) => domain !== "");
  return [
    "function FindProxyForURL(url, host) {",
    // A name may end with the root's dot and is still the same name.
    "  var name = host.toLowerCase().replace(/\\.+$/, '');",
    `  var domains = ${JSON.stringify(suffixes)};`,
    "  for (var index = 0; index < domains.length; index++) {",
    "    var domain = domains[index];",
    "    if (name === domain || dnsDomainIs(name, '.' + domain)) {",
    `      return ${JSON.stringify(`PROXY ${proxy.host}:${proxy.port}`)};`,
    "    }",
    "  }",
    "  return 'DIRECT';",
    "}",
  ].join("\n");
};

// Chromium takes a PAC script reliably only as a data: URL.
export const pacDataUrl = (script: string): string =>
  `data:application/x-ns-proxy-autoconfig;base64,${btoa(script)}`;

export const statusOf = (state: NodeState): TailnetStatus => {
  switch (state.state.case) {
    case "needsLogin":
      return { tailnet: state.tailnet, state: "needs-login" };
    case "running":
      return { tailnet: state.tailnet, state: "running", addresses: state.state.value.addresses };
    case "stopped":
      return { tailnet: state.tailnet, state: "stopped", problem: state.state.value.reason };
    case "starting":
    case undefined:
      return { tailnet: state.tailnet, state: "starting" };
  }
};

const replaceStatus = (
  statuses: ReadonlyArray<TailnetStatus>,
  next: TailnetStatus,
): ReadonlyArray<TailnetStatus> =>
  statuses.map((status) => (status.tailnet === next.tailnet ? next : status));

// What the app knows of its tailnets: each one's status, and which nodes have reported on their
// own since they started.
export interface TailnetBoard {
  readonly statuses: ReadonlyArray<TailnetStatus>;
  readonly reported: ReadonlySet<string>;
}

export const startingBoard = (tailnets: ReadonlyArray<string>): TailnetBoard => ({
  statuses: tailnets.map((tailnet) => ({ tailnet, state: "starting" })),
  reported: new Set(),
});

// A node's own report is always the newest word on it.
export const afterEvent = (board: TailnetBoard, next: TailnetStatus): TailnetBoard => ({
  statuses: replaceStatus(board.statuses, next),
  reported: new Set([...board.reported, next.tailnet]),
});

// The reply to a start never takes the place of a report that came first, whichever order the
// two reach the board in. A failed start always counts.
export const afterReply = (board: TailnetBoard, next: TailnetStatus): TailnetBoard =>
  board.reported.has(next.tailnet) && next.state !== "stopped"
    ? board
    : { ...board, statuses: replaceStatus(board.statuses, next) };

// The system's browser opens a node's sign-in only on its own control server, over HTTPS and
// without credentials, so a control server cannot make the app open anything else.
export const isSafeLoginUrl = (loginUrl: string, controlUrl: string): boolean => {
  try {
    const login = new URL(loginUrl);
    const control = new URL(controlUrl);
    return (
      login.protocol === "https:" &&
      login.username === "" &&
      login.password === "" &&
      login.host === control.host
    );
  } catch {
    return false;
  }
};

// Answers the proxy's challenge with its credentials, and no other proxy's, for the scope's life.
const answerProxyChallenge = (proxy: ProxyEndpoint) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (
        event: Electron.Event,
        _contents: Electron.WebContents | null,
        _details: Electron.AuthenticationResponseDetails,
        authInfo: Electron.AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (!authInfo.isProxy || authInfo.host !== proxy.host || authInfo.port !== proxy.port) {
          return;
        }
        event.preventDefault();
        callback(proxy.username, proxy.password);
      };
      Electron.app.on("login", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => Electron.app.off("login", listener)),
  );

export interface TailnetOptions {
  readonly connection: HelperConnection;
  readonly tailnets: ReadonlyArray<TailnetConfig>;
  readonly session: Electron.Session;
  readonly observer: NavigationObserver;
  readonly stateRoot: string;
  // The node's state key from its sealed file, kept only sealed by the system's keystore
  // (NodeKeys, ADR 0003).
  readonly stateKeyOf: (keyFile: string) => Effect.Effect<Uint8Array, NodeKeyError>;
}

export interface Tailnets {
  // The tailnets' current statuses, for the local windows' bridge outside any Effect.
  readonly current: () => ReadonlyArray<TailnetStatus>;
  // Calls the listener after every change of a status; the result stops it.
  readonly subscribe: (listener: () => void) => () => void;
}

interface Recovery {
  readonly keyFile: string;
  readonly stateDirectory: string;
}

// A tailnet whose node key the keystore did not give: no keystore, or a key it does not open.
export const stoppedForKey = (
  tailnet: string,
  error: NodeKeyError,
  recovery: Recovery,
): TailnetStatus => {
  switch (error.reason) {
    case "no-keystore":
      return { tailnet, state: "stopped", problem: error.problem, reason: "no-keystore" };
    case "key-unreadable":
      return {
        tailnet,
        state: "stopped",
        problem: error.problem,
        reason: "key-unreadable",
        recovery,
      };
    case "key-not-saved":
      return { tailnet, state: "stopped", problem: error.problem };
  }
};

// The helper's code for a node whose sealed state does not open with its key (statestore.go).
const FAILURE_STATE_UNREADABLE = "state_unreadable";

// A tailnet whose node the helper did not start.
export const stoppedForFailure = (
  tailnet: string,
  failure: { readonly code: string; readonly message: string },
  recovery: Recovery,
): TailnetStatus =>
  failure.code === FAILURE_STATE_UNREADABLE
    ? { tailnet, state: "stopped", problem: failure.message, reason: "state-unreadable", recovery }
    : { tailnet, state: "stopped", problem: failure.message };

// Runs the tailnets for as long as the scope lives.
export const run = Effect.fn("Tailnet.run")(function* (options: TailnetOptions) {
  const path = yield* Path.Path;
  const first = yield* options.connection.events.pipe(Stream.runHead);
  const proxy =
    Option.isSome(first) && first.value.kind.case === "proxyEndpoint"
      ? first.value.kind.value
      : undefined;
  if (proxy === undefined) {
    return yield* new TailnetError({ problem: "the helper did not announce its proxy" });
  }

  yield* answerProxyChallenge(proxy);
  const domains = options.tailnets.flatMap((tailnet) => tailnet.domains);
  yield* Effect.promise(() =>
    options.session.setProxy({
      mode: "pac_script",
      pacScript: pacDataUrl(pacScript(domains, proxy)),
    }),
  );

  let board = startingBoard(options.tailnets.map((tailnet) => tailnet.tailnet));
  const listeners = new Set<() => void>();
  const change = (next: TailnetBoard) =>
    Effect.sync(() => {
      board = next;
      for (const listener of listeners) listener();
    });
  const controlUrlOf = (tailnet: string) =>
    options.tailnets.find((candidate) => candidate.tailnet === tailnet)?.controlUrl ?? "";
  const openSignIn = (tailnet: string, loginUrl: string) =>
    isSafeLoginUrl(loginUrl, controlUrlOf(tailnet))
      ? Effect.sync(() => options.observer.openExternally(loginUrl))
      : Effect.logWarning(
          `tailnet ${tailnet}: refused a sign-in address outside its control server`,
        );
  yield* options.connection.events.pipe(
    Stream.runForEach((message) => {
      if (message.kind.case !== "nodeState") return Effect.void;
      const state = message.kind.value;
      const signIn =
        state.state.case === "needsLogin"
          ? openSignIn(state.tailnet, state.state.value.loginUrl)
          : Effect.void;
      return signIn.pipe(
        Effect.andThen(Effect.suspend(() => change(afterEvent(board, statusOf(state))))),
      );
    }),
    Effect.forkScoped,
  );

  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .makeDirectory(options.stateRoot, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.mapError(
        () => new TailnetError({ problem: "the tailnets' state directory cannot be made" }),
      ),
    );
  for (const tailnet of options.tailnets) {
    const stateDirectory = path.join(options.stateRoot, tailnet.tailnet);
    // Deleting both starts the node afresh: it signs in again and needs approval again.
    const recovery = {
      keyFile: path.join(options.stateRoot, `${tailnet.tailnet}.key`),
      stateDirectory,
    };
    // A node whose key the keystore does not give starts nowhere, and says why.
    const key = yield* options.stateKeyOf(recovery.keyFile).pipe(
      Effect.map((value) => ({ _tag: "Key" as const, value })),
      Effect.catch((error) => Effect.succeed({ _tag: "NoKey" as const, error })),
    );
    if (key._tag === "NoKey") {
      yield* change(afterReply(board, stoppedForKey(tailnet.tailnet, key.error, recovery)));
      continue;
    }
    const reply = yield* options.connection.request({
      case: "startNode",
      value: create(StartNodeSchema, {
        tailnet: tailnet.tailnet,
        controlUrl: tailnet.controlUrl,
        hostname: tailnet.hostname,
        stateDirectory,
        domains: [...tailnet.domains],
        stateKey: key.value,
      }),
    });
    const next: TailnetStatus =
      reply.kind.case === "nodeState"
        ? statusOf(reply.kind.value)
        : reply.kind.case === "failure"
          ? stoppedForFailure(tailnet.tailnet, reply.kind.value, recovery)
          : { tailnet: tailnet.tailnet, state: "stopped", problem: "no answer" };
    yield* change(afterReply(board, next));
  }

  const tailnets: Tailnets = {
    current: () => board.statuses,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return tailnets;
});
