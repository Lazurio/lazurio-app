import { create } from "@bufbuild/protobuf";
import {
  StartNodeSchema,
  type NodeState,
  type ProxyEndpoint,
} from "@lazurio/app-contracts/tailnet/v1";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Electron from "electron";

import type { TailnetStatus } from "../shared/bridge.ts";
import type { NavigationObserver } from "./Hardening.ts";
import type { HelperConnection } from "./Helpers.ts";
import type { NodeKeyError } from "./NodeKeys.ts";
import { stoppedForFailure, stoppedForKey } from "./StoppedTailnet.ts";

// The app's side of the tailnet helper (decision 0248): it starts one node per tailnet, gives the
// remote views a PAC script that sends only the tailnets' names to the helper's proxy, answers the
// proxy's challenge with its credentials, and opens a node's sign-in in the system's browser.

const TailnetConfig = Schema.Struct({
  tailnet: Schema.String,
  controlUrl: Schema.String,
  hostname: Schema.String,
  domains: Schema.Array(Schema.String),
});
export type TailnetConfig = typeof TailnetConfig.Type;

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

// The tailnet whose domains serve the address's name, as the PAC script and the helper's proxy
// route it; none for a name outside every tailnet, or for an address that is not one.
export const servingTailnet = (
  tailnets: ReadonlyArray<TailnetConfig>,
  address: string,
): string | undefined => {
  const url = URL.parse(address);
  if (url === null) return undefined;
  const name = normalizeDomain(url.hostname);
  return tailnets.find((tailnet) =>
    tailnet.domains
      .map(normalizeDomain)
      .some((domain) => domain !== "" && (name === domain || name.endsWith(`.${domain}`))),
  )?.tailnet;
};

// The tailnet helper's proxy for a host the app's tailnets serve, for the app's own connections
// such as the Device's channel (docs/adr/0006, point 3); none for any other host. Only a bare name
// counts: a port, credentials or a path never pass for a tailnet's host.
export const proxyForHost = (
  tailnets: ReadonlyArray<TailnetConfig>,
  proxy: ProxyEndpoint,
  host: string,
): Option.Option<ProxyEndpoint> =>
  /^[A-Za-z0-9.-]+$/u.test(host) && servingTailnet(tailnets, `https://${host}/`) !== undefined
    ? Option.some(proxy)
    : Option.none();

// Chromium takes a PAC script reliably only as a data: URL.
export const pacDataUrl = (script: string): string =>
  `data:application/x-ns-proxy-autoconfig;base64,${btoa(script)}`;

export const statusOf = (state: NodeState): TailnetStatus => {
  switch (state.state.case) {
    case "needsLogin":
      // Whether its address can be copied is the board's to say (withSignIns).
      return { tailnet: state.tailnet, state: "needs-login", canCopySignIn: false };
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

// The sign-in address a person may copy, by tailnet: the browser leaves it for OIDC at once.
// Only the newest report counts, and only needsLogin on the node's own control server
// (isSafeLoginUrl); any other report drops it. It goes only to the clipboard on request,
// never to a window, the log or the status text.
export const signInsAfter = (
  signIns: ReadonlyMap<string, string>,
  state: NodeState,
  controlUrl: string,
): ReadonlyMap<string, string> => {
  const next = new Map(signIns);
  if (state.state.case === "needsLogin" && isSafeLoginUrl(state.state.value.loginUrl, controlUrl)) {
    next.set(state.tailnet, state.state.value.loginUrl);
  } else {
    next.delete(state.tailnet);
  }
  return next;
};

// Only a tailnet whose status still waits for sign-in keeps its address; a failed start, for one,
// stops the node without a report of its own.
export const keptSignIns = (
  signIns: ReadonlyMap<string, string>,
  statuses: ReadonlyArray<TailnetStatus>,
): ReadonlyMap<string, string> =>
  new Map(
    [...signIns].filter(([tailnet]) =>
      statuses.some((status) => status.tailnet === tailnet && status.state === "needs-login"),
    ),
  );

// The statuses for the windows: a tailnet that waits for sign-in says whether its address can be
// copied, never the address itself.
export const withSignIns = (
  statuses: ReadonlyArray<TailnetStatus>,
  signIns: ReadonlyMap<string, string>,
): ReadonlyArray<TailnetStatus> =>
  statuses.map((status) =>
    status.state === "needs-login"
      ? { ...status, canCopySignIn: signIns.has(status.tailnet) }
      : status,
  );

const isHelperProxy = (authInfo: Electron.AuthInfo, proxy: ProxyEndpoint): boolean =>
  authInfo.isProxy && authInfo.host === proxy.host && authInfo.port === proxy.port;

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
        if (!isHelperProxy(authInfo, proxy)) return;
        event.preventDefault();
        callback(proxy.username, proxy.password);
      };
      Electron.app.on("login", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => Electron.app.off("login", listener)),
  );

// A service worker's navigation preload cannot answer the proxy's challenge, and the window then
// shows the proxy's empty 407 (Lazurio/lazurio-app#36). One answered request of the app's own puts
// the credentials in the session, which sends them at once from then on; plain HTTP ends at the
// proxy (it tunnels only CONNECT), so nothing reaches a tailnet.
const primeProxyCredentials = (session: Electron.Session, proxy: ProxyEndpoint, domain: string) =>
  Effect.callback<boolean>((resume) => {
    let answered = false;
    const request = Electron.net.request({
      url: `http://${domain}/`,
      session,
      redirect: "manual",
      useSessionCookies: false,
    });
    request.on("login", (authInfo, callback) => {
      if (!isHelperProxy(authInfo, proxy)) return callback();
      answered = true;
      callback(proxy.username, proxy.password);
    });
    request.on("response", (response) => {
      response.on("data", () => {});
      response.on("end", () => resume(Effect.succeed(answered)));
      response.on("error", () => resume(Effect.succeed(answered)));
    });
    request.on("redirect", () => {
      request.abort();
      resume(Effect.succeed(answered));
    });
    request.on("error", () => resume(Effect.succeed(answered)));
    request.end();
    return Effect.sync(() => request.abort());
  }).pipe(
    Effect.timeoutOption(PRIME_GIVES_UP),
    Effect.map((answered) => Option.getOrElse(answered, () => false)),
    Effect.tap((answered) => Effect.logInfo("tailnet proxy credentials", { answered })),
  );

// A request to the loopback proxy takes milliseconds. The start waits for it this long, the
// request itself runs on until it gives up, and one without an answered challenge goes again.
const PRIME_WITHIN = "5 seconds";
const PRIME_GIVES_UP = "30 seconds";

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
  // Waits until the tailnet that serves the address runs; at once for an address no tailnet serves.
  readonly whenReachable: (address: string) => Effect.Effect<void>;
  // The tailnet helper's proxy, with the credentials of its current start, for a host in a
  // tailnet's domains; none for a host no tailnet serves (proxyForHost).
  readonly proxyFor: (host: string) => Option.Option<ProxyEndpoint>;
  // The newest safe sign-in address of a tailnet that waits for sign-in, for the clipboard only
  // (signInsAfter); none for any other tailnet.
  readonly signInAddress: (tailnet: string) => Option.Option<string>;
}

// Tailnets of an app that runs no tailnet helper: every address is reachable as it is.
export const noTailnets: Tailnets = {
  current: () => [],
  subscribe: () => () => {},
  whenReachable: () => Effect.void,
  proxyFor: () => Option.none(),
  signInAddress: () => Option.none(),
};

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
  // Which proxy the remote views' session takes for each tailnet's domain, for the log: a PAC
  // script that did not take sends that name directly and the page fails.
  for (const domain of domains) {
    const chosen = yield* Effect.promise(() =>
      options.session.resolveProxy(`https://${normalizeDomain(domain)}/`),
    );
    yield* Effect.logInfo("tailnet proxy", { domain, chosen });
  }
  const firstDomain = domains.map(normalizeDomain).find((domain) => domain !== "");
  // No window navigates before the answer, within PRIME_WITHIN (review of #66); the requests go
  // on beside the start until one challenge is answered.
  if (firstDomain !== undefined) {
    const primed = yield* primeProxyCredentials(options.session, proxy, firstDomain).pipe(
      Effect.repeat({ schedule: Schedule.spaced(PRIME_WITHIN), until: (answered) => answered }),
      Effect.forkScoped,
    );
    yield* Fiber.join(primed).pipe(Effect.timeoutOption(PRIME_WITHIN));
  }

  let board = startingBoard(options.tailnets.map((tailnet) => tailnet.tailnet));
  let signIns: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<() => void>();
  const change = (next: TailnetBoard) =>
    Effect.sync(() => {
      board = next;
      signIns = keptSignIns(signIns, board.statuses);
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
        Effect.andThen(
          Effect.suspend(() => {
            signIns = signInsAfter(signIns, state, controlUrlOf(state.tailnet));
            return change(afterEvent(board, statusOf(state)));
          }),
        ),
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
    // The node's files, which the window names when the node does not start (ADR 0003).
    const files = {
      keyFile: path.join(options.stateRoot, `${tailnet.tailnet}.key`),
      stateDirectory,
    };
    // A node whose key the keystore does not give starts nowhere, and says why.
    const key = yield* options.stateKeyOf(files.keyFile).pipe(
      Effect.map((value) => ({ _tag: "Key" as const, value })),
      Effect.catch((error) => Effect.succeed({ _tag: "NoKey" as const, error })),
    );
    if (key._tag === "NoKey") {
      yield* change(afterReply(board, stoppedForKey(tailnet.tailnet, key.error, files)));
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
          ? stoppedForFailure(tailnet.tailnet, reply.kind.value, files)
          : { tailnet: tailnet.tailnet, state: "stopped", problem: "no answer" };
    yield* change(afterReply(board, next));
  }

  const runs = (tailnet: string) =>
    board.statuses.some((status) => status.tailnet === tailnet && status.state === "running");
  const tailnets: Tailnets = {
    current: () => withSignIns(board.statuses, signIns),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenReachable: (address) => {
      const tailnet = servingTailnet(options.tailnets, address);
      if (tailnet === undefined) return Effect.void;
      return Effect.callback<void>((resume) => {
        if (runs(tailnet)) {
          resume(Effect.void);
          return;
        }
        const listener = () => {
          if (!runs(tailnet)) return;
          listeners.delete(listener);
          resume(Effect.void);
        };
        listeners.add(listener);
        return Effect.sync(() => {
          listeners.delete(listener);
        });
      });
    },
    proxyFor: (host) => proxyForHost(options.tailnets, proxy, host),
    signInAddress: (tailnet) => Option.fromUndefinedOr(signIns.get(tailnet)),
  };
  return tailnets;
});
