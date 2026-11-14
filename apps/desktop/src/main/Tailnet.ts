import { create } from "@bufbuild/protobuf";
import {
  StartNodeSchema,
  type NodeState,
  type ProxyEndpoint,
} from "@lazurio/app-contracts/tailnet/v1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import type { TailnetStatus } from "../shared/bridge.ts";
import type { NavigationObserver } from "./Hardening.ts";
import type { HelperConnection } from "./Helpers.ts";

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
    "  var name = host.toLowerCase();",
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
}

// Runs the tailnets for as long as the scope lives. The result reads their current statuses, for
// the local windows' bridge outside any Effect.
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

  let statuses: ReadonlyArray<TailnetStatus> = options.tailnets.map((tailnet) => ({
    tailnet: tailnet.tailnet,
    state: "starting",
  }));
  const update = (next: TailnetStatus) =>
    Effect.sync(() => {
      statuses = replaceStatus(statuses, next);
    });
  yield* options.connection.events.pipe(
    Stream.runForEach((message) => {
      if (message.kind.case !== "nodeState") return Effect.void;
      const state = message.kind.value;
      if (state.state.case === "needsLogin")
        options.observer.openExternally(state.state.value.loginUrl);
      return update(statusOf(state));
    }),
    Effect.forkScoped,
  );

  for (const tailnet of options.tailnets) {
    const reply = yield* options.connection.request({
      case: "startNode",
      value: create(StartNodeSchema, {
        tailnet: tailnet.tailnet,
        controlUrl: tailnet.controlUrl,
        hostname: tailnet.hostname,
        stateDirectory: path.join(options.stateRoot, tailnet.tailnet),
        domains: [...tailnet.domains],
      }),
    });
    const next: TailnetStatus =
      reply.kind.case === "nodeState"
        ? statusOf(reply.kind.value)
        : {
            tailnet: tailnet.tailnet,
            state: "stopped",
            problem: reply.kind.case === "failure" ? reply.kind.value.message : "no answer",
          };
    yield* update(next);
  }

  return (): ReadonlyArray<TailnetStatus> => statuses;
});
