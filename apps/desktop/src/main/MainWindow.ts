import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as HostProcess from "@lazurio/app-shared/HostProcess";
import * as Electron from "electron";

import { APP_NAME } from "../shared/appName.ts";
import {
  STATUS_CHANNEL,
  TAB_COMMAND_CHANNEL,
  TABS_CHANGED_CHANNEL,
  TABS_CHANNEL,
  type AppStatus,
  type PageOutcome,
  type TabCommand,
  type TabsView,
} from "../shared/bridge.ts";
import { problemQuery, type PageProblem } from "../shared/pageProblem.ts";
import {
  hardenSession,
  hostOf,
  onMainFrameRefused,
  onOpenTab,
  registerView,
  type TabRequest,
} from "./Hardening.ts";
import { LOCAL_ENTRY } from "./LocalScheme.ts";
import { tabTitleOf } from "./TabTitle.ts";
import { destinationOf, isOrganizationHost } from "./Navigation.ts";
import {
  activated,
  atPosition,
  canClose,
  closed,
  opened,
  single,
  stepped,
  tabKeyOf,
  type TabKey,
  type TabList,
} from "./Tabs.ts";

// The main window: the local view with the preload bridge in a column, and beside it the tabs of
// the web Lazurio (#82): a strip the app draws, and under it one remote view per tab, without
// preload and all in the same session of their own. The views of a BaseWindow never overlap, so
// no page is laid out under another; only the front tab's view shows.

// The session of every remote view; the tailnet gives it its PAC script (Tailnet.ts).
export const REMOTE_PARTITION = "persist:lazurio-remote";
const LOCAL_COLUMN_WIDTH = 360;
// The local page's background, shown before a page paints instead of white.
const WINDOW_BACKGROUND = "#111318";

export interface MainWindowOptions {
  readonly preloadPath: string;
  // Reads the app's current status whenever a local window asks.
  readonly status: () => AppStatus;
  readonly remoteUrl: Option.Option<string>;
  // Waits until the remote page's tailnet can reach it (Tailnet.Tailnets.whenReachable).
  readonly whenReachable: (url: string) => Effect.Effect<void>;
  // Learns each page the remote view's main frame shows (Agent Desktop offers to add its
  // Environment).
  readonly pageShown: (url: string) => void;
  // The page's history changed, so the View menu's Back and Forward follow it.
  readonly historyChanged: () => void;
  // How each navigation of the page ended, for Copy status.
  readonly pageOutcome: (outcome: PageOutcome) => void;
  // Whether a tailnet serves the address (Tailnet.Tailnets.proxyFor): only such a page waits for
  // its Environment to become reachable, for example for the Organization to approve the Device.
  readonly servedByTailnet: (address: string) => boolean;
  // Whether the Organization's network is missing (a stable build without a setting): a failed
  // load then says that, not a host that cannot be found (#81).
  readonly networkMissing: () => boolean;
  // The window, as soon as it exists, so the tray, a second start or the Dock can show it.
  readonly created: (window: Electron.BaseWindow) => void;
  // Whether the window shows once its page loaded: not at a start with --hidden, unless a second
  // start or the tray asked for it meanwhile.
  readonly showOnLoad: () => boolean;
  // What closing the window does (Lifecycle.closeStep), and what follows when it hides.
  readonly closeStep: () => "hide" | "close" | "keep";
  readonly hidden: () => void;
  // Windows ends the person's session (log off, restart): the app quits.
  readonly sessionEnds: () => void;
  // Whether the app's status column shows beside the page; hidden by default (2026-11-18).
  readonly statusShown: () => boolean;
  // A bar above the page, laid out with the window (Agent Desktop's "an agent works" bar).
  readonly topBar?: { readonly view: Electron.WebContentsView; readonly height: () => number };
  // The window's controls once its views exist: lay them out again, reload the page.
  readonly controls: (controls: MainWindowControls) => void;
}

export interface MainWindowControls {
  // Lays the views out again, after the status column or the top bar showed or hid.
  readonly relayout: () => void;
  readonly reloadPage: () => void;
  // Back and Forward in the page's history, and where it can go (the View menu).
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly history: () => { readonly canGoBack: boolean; readonly canGoForward: boolean };
  // Loads the page again from the app's page that says why it did not show; settles once the
  // attempt has shown or failed.
  readonly retryPage: () => Promise<void>;
  // Loads the window's first page, the Overview, instead (#68); settles like retryPage.
  readonly firstPage: () => Promise<void>;
  // Whether the window has tabs (it has a page), for the menu's tab items.
  readonly tabs: () => { readonly open: boolean };
  // What a tab's key or menu item does (Tabs.TabKey).
  readonly tabKey: (key: TabKey) => void;
}

// The first remote page loads again after these failures, which a network that changed or a
// tailnet node that started a moment ago gives (Lazurio/lazurio-app#5), up to three times in all.
const RETRIED_FAILURES: ReadonlySet<string> = new Set([
  "ERR_NETWORK_CHANGED",
  "ERR_TUNNEL_CONNECTION_FAILED",
]);
const codeOf = (failure: unknown): string =>
  typeof failure === "object" &&
  failure !== null &&
  "code" in failure &&
  typeof failure.code === "string"
    ? failure.code
    : "";

class RemoteLoadError extends Schema.TaggedError<RemoteLoadError>()("RemoteLoadError", {
  code: Schema.String,
}) {}

// The sender's frame must be a local window of the app. Compared through destinationOf, not URL
// origins: Node's URL gives a custom scheme the opaque origin "null".
const isLocalSender = (event: Electron.IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url;
  return url !== undefined && destinationOf(url)._tag === "Local";
};

const serveStatus = (status: () => AppStatus) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Electron.ipcMain.handle(STATUS_CHANNEL, (event) => {
        if (!isLocalSender(event)) throw new Error("refused: not a local window of the app");
        return status();
      }),
    ),
    () => Effect.sync(() => Electron.ipcMain.removeHandler(STATUS_CHANNEL)),
  );

// What the remote page's renderer sees, for the log. A page is hidden to it while the system's
// display is off, and the window then stays blank (the trial of 2026-11-17), so the log also gives
// the seconds since the last input, which a long idle time points to.
const PAGE_STATE = `({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })`;

// A view of the app's own pages with the bridge: sandboxed, isolated, no Node (DevicePanel.ts).
export const localViewOptions = (preloadPath: string): Electron.WebContentsViewConstructorOptions =>
  viewOptions({ preload: preloadPath });

const viewOptions = (
  preferences: Electron.WebPreferences,
): Electron.WebContentsViewConstructorOptions => ({
  webPreferences: {
    ...preferences,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  },
});

// A view and its page live as long as the scope; a closed window does not close a view's page.
const acquireView = (options: Electron.WebContentsViewConstructorOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => new Electron.WebContentsView(options)),
    (view) =>
      Effect.sync(() => {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }),
  );

const loadRemote = Effect.fn("MainWindow.loadRemote")(function* (
  window: Electron.BaseWindow,
  view: Electron.WebContentsView,
  url: string,
  whenReachable: (url: string) => Effect.Effect<void>,
) {
  // The page loads only once its tailnet runs, so the first load does not fail while the node
  // starts.
  yield* whenReachable(url).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => view.webContents.loadURL(url),
        catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
      }),
    ),
    Effect.retry({ times: 2, while: (failure) => RETRIED_FAILURES.has(failure.code) }),
    Effect.ignore,
  );
  const page = yield* Effect.tryPromise({
    try: () => view.webContents.executeJavaScript(PAGE_STATE) as Promise<unknown>,
    catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
  }).pipe(Effect.orElseSucceed(() => "unknown"));
  yield* Effect.logInfo("remote view", {
    windowVisible: window.isVisible(),
    viewVisible: view.getVisible(),
    bounds: view.getBounds(),
    page,
    idleSeconds: Electron.powerMonitor.getSystemIdleTime(),
  });
});

// Chromium's errors for a tailnet's page its node cannot reach yet (the Device waits for approval,
// or the network is not up): NETWORK_CHANGED, CONNECTION_REFUSED, NAME_NOT_RESOLVED,
// ADDRESS_UNREACHABLE, TUNNEL_CONNECTION_FAILED, CONNECTION_TIMED_OUT, PROXY_CONNECTION_FAILED.
const UNREACHABLE: ReadonlySet<number> = new Set([-21, -102, -105, -109, -111, -118, -130]);
// How often a waiting page tries its address again.
const RETRY_EVERY = "5 seconds";

interface PageWatch {
  readonly retry: () => Promise<void>;
  readonly first: () => Promise<void>;
  readonly reload: () => void;
}

// The page never stays blank (#36): an unreachable tailnet's page waits and loads again every few
// seconds (task 648); any other failed load, refused redirect, proxy 407 or gone renderer shows
// the reason and Retry. Each outcome is logged (host and code) and kept for Copy status (code).
// One watch per tab; the window shows the app's page in the tab's place (coverChanged).
const watchPage = Effect.fn("MainWindow.watchPage")(function* (options: {
  readonly remote: Electron.WebContentsView;
  // Where Retry goes while the tab has shown no page yet.
  readonly startAddress: string;
  // The window's first page, the Overview.
  readonly firstAddress: string;
  readonly servedByTailnet: (address: string) => boolean;
  readonly networkMissing: () => boolean;
  readonly outcome: (outcome: PageOutcome) => void;
  // The app's page that says why the page does not show, to show in its place; none for the page.
  readonly coverChanged: (address: string | undefined) => void;
  // A tab that a page opened went to the system's browser before it showed any page.
  readonly leftForBrowser?: () => void;
}) {
  const { remote } = options;
  const contents = remote.webContents;
  const log = Effect.runForkWith(yield* Effect.context<never>());
  // A tailnet's address that waits to become reachable.
  let pending: string | undefined;
  // The address Retry loads, while the app's page shows instead of the page.
  let retryAddress: string | undefined;
  // The address of the app's page in the page's place, while it shows or loads.
  let covered: string | undefined;
  let lastShown: string | undefined;

  const uncover = () => {
    covered = undefined;
    options.coverChanged(undefined);
  };
  const showCover = (address: string) => {
    covered = address;
    options.coverChanged(address);
  };
  const showProblem = (problem: PageProblem, outcome: PageOutcome, retry: string) => {
    pending = undefined;
    retryAddress = retry;
    showCover(`${LOCAL_ENTRY}${problemQuery(problem)}#waiting`);
    options.outcome(outcome);
  };
  // A refused navigation ends without any failure: a page that shows stays as it is, but in place
  // of nothing or of the app's page (a Retry refused, review of #66) the reason must show.
  onMainFrameRefused(contents, (refused) => {
    const inBrowser = destinationOf(refused.address)._tag === "SystemBrowser";
    if (lastShown === undefined && inBrowser && options.leftForBrowser !== undefined) {
      options.outcome({ outcome: "refused", inBrowser });
      return options.leftForBrowser();
    }
    if (lastShown !== undefined && covered === undefined) {
      return options.outcome({ outcome: "refused", inBrowser });
    }
    showProblem(
      { kind: inBrowser ? "browser" : "refused", host: hostOf(refused.address) },
      { outcome: "refused", inBrowser },
      lastShown ?? options.startAddress,
    );
  });
  contents.on("did-navigate", (_event, address, responseCode) => {
    const host = hostOf(address);
    // The tailnet helper's proxy answered instead of the page: never an Environment's own page.
    if (responseCode === 407) {
      log(Effect.logWarning("page refused by the proxy", { host }));
      showProblem({ kind: "proxy", host }, { outcome: "proxy-refused" }, address);
      return;
    }
    if (responseCode <= 0) return;
    lastShown = address;
    pending = undefined;
    retryAddress = undefined;
    log(Effect.logInfo("page shown", { host, responseCode }));
    options.outcome({ outcome: "shown", responseCode });
    if (covered !== undefined) uncover();
  });
  contents.on("did-fail-load", (_event, code, description, address, isMainFrame) => {
    if (!isMainFrame) return;
    // An abort follows a newer navigation, a page's stop or a download, or the proxy's 407 above.
    if (code === -3) return;
    const host = hostOf(address);
    if (UNREACHABLE.has(code) && options.servedByTailnet(address)) {
      log(Effect.logWarning("page waits for its tailnet", { host, code }));
      pending = address;
      retryAddress = address;
      showCover(`${LOCAL_ENTRY}${problemQuery({ kind: "waiting", code, host })}#waiting`);
      options.outcome({ outcome: "waiting", code });
      return;
    }
    log(Effect.logWarning("page failed", { host, code, description }));
    // Only a page of the Organization's network fails for want of it; any other failure, the
    // public Dashboard's for one, keeps its own reason (review of #84).
    const kind = options.networkMissing() && isOrganizationHost(host) ? "network" : "failed";
    showProblem({ kind, code, host }, { outcome: "failed", code }, address);
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log(Effect.logError("page renderer gone", { reason: details.reason }));
    showProblem(
      { kind: "crashed" },
      { outcome: "crashed", reason: details.reason },
      lastShown ?? options.startAddress,
    );
  });
  // One attempt at a time: the next waits until the previous load has finished or failed, so a
  // reachable Environment that answers slowly is not cancelled by the next attempt.
  yield* Effect.sleep(RETRY_EVERY).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const address = pending;
        if (address === undefined || contents.isDestroyed()) return Effect.void;
        return Effect.tryPromise({
          try: () => contents.loadURL(address),
          catch: (failure) => new RemoteLoadError({ code: codeOf(failure) }),
        }).pipe(Effect.ignore);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  const retry = async () => {
    if (contents.isDestroyed()) return;
    const address = retryAddress ?? (contents.getURL() || options.startAddress);
    await contents.loadURL(address).catch(() => undefined);
  };
  return {
    retry,
    // The Environment is left: its address no longer loads again by itself, so a slow first page
    // is not cut off by the next attempt (review of #70).
    first: async () => {
      if (contents.isDestroyed()) return;
      pending = undefined;
      retryAddress = undefined;
      await contents.loadURL(options.firstAddress).catch(() => undefined);
    },
    reload: () => {
      if (contents.isDestroyed()) return;
      if (covered !== undefined) void retry();
      else contents.reload();
    },
  } satisfies PageWatch;
});

// The strip of tabs over the page (#82, variant A): Back, Forward, Reload, the tabs and a new tab.
const STRIP_HEIGHT = 40;

// What the strip asks for, decoded before it acts (every value from outside goes through Schema).
const TabCommandSchema = Schema.Union([
  Schema.TaggedStruct("Activate", { id: Schema.Number }),
  Schema.TaggedStruct("Close", { id: Schema.Number }),
  Schema.TaggedStruct("New", {}),
  Schema.TaggedStruct("Back", {}),
  Schema.TaggedStruct("Forward", {}),
  Schema.TaggedStruct("Reload", {}),
]);
const decodeTabCommand = Schema.decodeUnknownEffect(TabCommandSchema);

// One tab: its page's view, the scope its page and watch live in, and the app's page that shows
// in its place while the page cannot.
interface Tab {
  readonly id: number;
  readonly view: Electron.WebContentsView;
  readonly scope: Scope.Closeable;
  watch: PageWatch | undefined;
  cover: string | undefined;
}

export const open = Effect.fn("MainWindow.open")(function* (options: MainWindowOptions) {
  yield* serveStatus(options.status);
  const context = yield* Effect.context<Scope.Scope>();
  const runSync = Effect.runSyncWith(context);
  const runFork = Effect.runForkWith(context);
  const windowScope = yield* Scope.Scope;
  const mac = (yield* HostProcess.Platform) === "darwin";
  const window = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Electron.BaseWindow({
          width: 1280,
          height: 800,
          show: false,
          title: APP_NAME,
          backgroundColor: WINDOW_BACKGROUND,
        }),
    ),
    (window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) window.destroy();
      }),
  );
  options.created(window);
  // Closing the window hides it, so the app and Agent Desktop run on (Tray.ts); only a quit closes it.
  // While an agent works it stays where it is.
  window.on("close", (event) => {
    const step = options.closeStep();
    if (step === "close") return;
    event.preventDefault();
    if (step === "keep") return;
    window.hide();
    options.hidden();
  });
  window.on("session-end", options.sessionEnds);
  const local = yield* acquireView(viewOptions({ preload: options.preloadPath }));
  local.setBackgroundColor(WINDOW_BACKGROUND);
  registerView(local.webContents, "Local");
  window.contentView.addChildView(local);

  // The tabs, by id, and their order with the one in front (Tabs.ts). The first tab's page is the
  // window's first page; its view comes right after the column, the app's page for a page that
  // cannot show after it, then every other tab, the strip and Agent Desktop's bar.
  const tabs = new Map<number, Tab>();
  let list: TabList | undefined;
  let nextId = 1;
  let waiting: Electron.WebContentsView | undefined;
  let strip: Electron.WebContentsView | undefined;
  // The address the app's page in a tab's place has loaded, and the one it loads now.
  let coverLoaded: string | undefined;
  let coverLoading: string | undefined;
  const firstAddress = Option.getOrUndefined(options.remoteUrl);

  const front = (): Tab | undefined => (list === undefined ? undefined : tabs.get(list.active));
  const tabsView = (): TabsView => {
    const shown = front()?.view.webContents;
    return {
      tabs: (list?.order ?? []).flatMap((id) => {
        const tab = tabs.get(id);
        if (tab === undefined || tab.view.webContents.isDestroyed()) return [];
        const contents = tab.view.webContents;
        return [{ id, title: tabTitleOf(contents.getURL()), loading: contents.isLoading() }];
      }),
      active: list?.active ?? 0,
      canClose: list !== undefined && canClose(list),
      canGoBack: shown?.navigationHistory.canGoBack() ?? false,
      canGoForward: shown?.navigationHistory.canGoForward() ?? false,
    };
  };
  // The strip learns every change of the tabs, their pages and the front tab's history.
  const publish = () => {
    if (strip === undefined || strip.webContents.isDestroyed()) return;
    strip.webContents.send(TABS_CHANGED_CHANNEL, tabsView());
  };
  // The front tab's page shows, or the app's page in its place once that has loaded, so a previous
  // reason never flashes; every other tab is hidden.
  const showFront = () => {
    const shown = front();
    const want = shown?.cover;
    const ready = want !== undefined && coverLoaded === want;
    for (const tab of tabs.values()) tab.view.setVisible(tab === shown && !ready);
    waiting?.setVisible(ready);
    if (waiting === undefined || want === undefined || ready || coverLoading === want) return;
    coverLoading = want;
    const cover = waiting.webContents;
    const loaded = () => {
      if (coverLoading !== want) return;
      coverLoading = undefined;
      coverLoaded = want;
      showFront();
    };
    if (cover.getURL() === want) loaded();
    else void cover.loadURL(want).then(loaded, loaded);
  };

  const layout = () => {
    // The content view's own size: on Linux the menu bar takes part of the content size.
    const { width, height } = window.contentView.getBounds();
    const hasPage = list !== undefined;
    const shown = !hasPage || options.statusShown();
    const column = !hasPage ? width : shown ? Math.min(LOCAL_COLUMN_WIDTH, width) : 0;
    // The bar spans the whole width over the column and the page, so its message, Stop and Agent
    // Desktop stay usable in a narrow window and without a remote page (review of #62).
    const bar = Math.min(options.topBar?.height() ?? 0, height);
    options.topBar?.view.setBounds({ x: 0, y: 0, width, height: bar });
    local.setVisible(shown);
    local.setBounds({ x: 0, y: bar, width: column, height: height - bar });
    const pageWidth = Math.max(0, width - column);
    const stripHeight = strip === undefined ? 0 : Math.min(STRIP_HEIGHT, height - bar);
    strip?.setBounds({ x: column, y: bar, width: pageWidth, height: stripHeight });
    const top = bar + stripHeight;
    const page = { x: column, y: top, width: pageWidth, height: Math.max(0, height - top) };
    for (const tab of tabs.values()) tab.view.setBounds(page);
    waiting?.setBounds(page);
  };

  // The front tab changed, or its page: the window shows it, the menu follows its history, Agent
  // Desktop learns its page (its offer to add the Environment) and the strip redraws.
  const frontChanged = () => {
    showFront();
    const shown = front();
    if (shown !== undefined && !shown.view.webContents.isDestroyed()) {
      options.pageShown(shown.view.webContents.getURL());
    }
    options.historyChanged();
    publish();
  };
  const activate = (next: TabList) => {
    const before = list?.active;
    list = next;
    if (next.active === before) return;
    frontChanged();
    front()?.view.webContents.focus();
  };

  const closeTab = (id: number) => {
    if (list === undefined) return;
    // The window keeps one tab at least: closing the last one closes the window, which hides it.
    if (!canClose(list)) {
      window.close();
      return;
    }
    const tab = tabs.get(id);
    if (tab === undefined) return;
    const before = list.active;
    list = closed(list, id);
    tabs.delete(id);
    window.contentView.removeChildView(tab.view);
    runFork(Scope.close(tab.scope, Exit.void));
    if (list.active !== before) {
      frontChanged();
      front()?.view.webContents.focus();
    } else publish();
  };

  const tabKey = (key: TabKey) => {
    if (list === undefined) return;
    switch (key._tag) {
      case "New":
        return newTab();
      case "Close":
        return closeTab(list.active);
      case "Step":
        return activate(stepped(list, key.by));
      case "Position":
        return activate(atPosition(list, key.position));
    }
  };
  const reloadPage = () => front()?.watch?.reload();
  // F5 reloads the page as View > Reload page does, and the tabs' keys act (Tabs.tabKeyOf): a menu
  // item has one accelerator, and a page holds the focus. Every view of the window, Agent
  // Desktop's bar included: its Stop may hold the focus.
  const catchKeys = (contents: Electron.WebContents) => {
    contents.on("before-input-event", (event, input) => {
      const key = tabKeyOf(input, mac);
      if (key !== undefined && list !== undefined) {
        event.preventDefault();
        tabKey(key);
        return;
      }
      if (input.type !== "keyDown" || input.key !== "F5") return;
      if (input.control || input.alt || input.meta || input.shift) return;
      event.preventDefault();
      reloadPage();
    });
  };

  // A tab for the view: registered as a page of Lazurio before it loads anything, with a watch of
  // its page in a scope of its own that closes with the tab or with the window.
  const addTab = (view: Electron.WebContentsView, startAddress: string, fromPage: boolean): Tab => {
    const id = nextId++;
    const contents = view.webContents;
    registerView(contents, "Lazurio");
    const scope = runSync(Scope.fork(windowScope, "sequential"));
    // Set once the app itself closes the tab's page: only a page that closed itself (a window it
    // opened, closed by window.close()) closes its tab.
    let ending = false;
    runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          ending = true;
          if (!contents.isDestroyed()) contents.close();
        }),
      ),
    );
    const tab: Tab = { id, view, scope, watch: undefined, cover: undefined };
    tabs.set(id, tab);
    const isFront = () => list?.active === id;
    contents.on("did-navigate", () => {
      if (isFront()) frontChanged();
      else publish();
    });
    contents.on("did-navigate-in-page", () => {
      if (isFront()) options.historyChanged();
      publish();
    });
    contents.on("did-start-loading", publish);
    contents.on("did-stop-loading", publish);
    catchKeys(contents);
    onOpenTab(contents, openFromPage);
    // A page closes its own tab (window.close() of a window it opened), as in a browser.
    contents.on("destroyed", () => {
      if (ending || window.isDestroyed() || tabs.get(id) !== tab) return;
      if (list !== undefined && canClose(list)) closeTab(id);
    });
    const index = strip === undefined ? -1 : window.contentView.children.indexOf(strip);
    if (index === -1) window.contentView.addChildView(view);
    else window.contentView.addChildView(view, index);
    tab.watch = runSync(
      Scope.provide(scope)(
        watchPage({
          remote: view,
          startAddress,
          firstAddress: firstAddress ?? startAddress,
          servedByTailnet: options.servedByTailnet,
          networkMissing: options.networkMissing,
          // Copy status tells how the front tab's page ended.
          outcome: (outcome) => {
            if (isFront()) options.pageOutcome(outcome);
          },
          coverChanged: (address) => {
            tab.cover = address;
            if (isFront()) showFront();
          },
          ...(fromPage ? { leftForBrowser: () => closeTab(id) } : {}),
        }),
      ),
    );
    return tab;
  };

  // A page of Lazurio opened a window (Hardening.onOpenTab): a new tab after the one in front,
  // which Chromium loads with the page's address, or leaves empty for the page to navigate.
  function openFromPage(request: TabRequest): Electron.WebContents {
    // Electron passes the page's new web contents in the options, beside their preferences; its
    // types leave the web contents out.
    const given: Electron.BrowserWindowConstructorOptions & {
      readonly webContents?: Electron.WebContents;
    } = request.options;
    const view = new Electron.WebContentsView({
      ...(given.webContents === undefined ? {} : { webContents: given.webContents }),
      ...(given.webPreferences === undefined ? {} : { webPreferences: given.webPreferences }),
    });
    const start = request.address === "about:blank" ? (firstAddress ?? "") : request.address;
    const tab = addTab(view, start, true);
    if (list !== undefined) {
      const next = opened(list, tab.id, request.background);
      list = next;
      layout();
      if (request.background) {
        showFront();
        publish();
      } else {
        frontChanged();
        view.webContents.focus();
      }
    }
    return view.webContents;
  }

  // A new tab of the person's own (Ctrl/Cmd+T, the strip's +): the window's first page.
  function newTab(): void {
    if (list === undefined || firstAddress === undefined) return;
    const view = new Electron.WebContentsView(viewOptions({ partition: REMOTE_PARTITION }));
    const tab = addTab(view, firstAddress, false);
    list = opened(list, tab.id, false);
    layout();
    frontChanged();
    view.webContents.focus();
    runFork(loadRemote(window, view, firstAddress, options.whenReachable));
  }

  let first: Tab | undefined;
  if (firstAddress !== undefined) {
    const remote = new Electron.WebContentsView(viewOptions({ partition: REMOTE_PARTITION }));
    first = addTab(remote, firstAddress, false);
    list = single(first.id);
    yield* hardenSession(remote.webContents.session);
    // The app's own page in a tab's place while its page cannot show. It has the bridge, so it can
    // open the status column.
    waiting = yield* acquireView(viewOptions({ preload: options.preloadPath }));
    waiting.setBackgroundColor(WINDOW_BACKGROUND);
    registerView(waiting.webContents, "Local");
    waiting.setVisible(false);
    window.contentView.addChildView(waiting);
    strip = yield* acquireView(viewOptions({ preload: options.preloadPath }));
    strip.setBackgroundColor(WINDOW_BACKGROUND);
    registerView(strip.webContents, "Local");
    window.contentView.addChildView(strip);
    yield* serveTabs({
      view: tabsView,
      command: (command) => {
        if (list === undefined) return;
        switch (command._tag) {
          case "Activate":
            return activate(activated(list, command.id));
          case "Close":
            return closeTab(command.id);
          case "New":
            return newTab();
          case "Back":
            return goBack();
          case "Forward":
            return goForward();
          case "Reload":
            return reloadPage();
        }
      },
    });
  }
  if (options.topBar !== undefined) window.contentView.addChildView(options.topBar.view);
  layout();
  // The content view changes size with the window and, on Linux, when the menu bar appears.
  window.contentView.on("bounds-changed", layout);
  for (const view of [local, waiting, strip, options.topBar?.view]) {
    if (view !== undefined) catchKeys(view.webContents);
  }
  function goBack(): void {
    const history = front()?.view.webContents.navigationHistory;
    if (history?.canGoBack() === true) history.goBack();
  }
  function goForward(): void {
    const history = front()?.view.webContents.navigationHistory;
    if (history?.canGoForward() === true) history.goForward();
  }
  options.controls({
    relayout: layout,
    reloadPage,
    goBack,
    goForward,
    history: () => {
      const history = front()?.view.webContents.navigationHistory;
      return {
        canGoBack: history?.canGoBack() ?? false,
        canGoForward: history?.canGoForward() ?? false,
      };
    },
    retryPage: () => front()?.watch?.retry() ?? Promise.resolve(),
    firstPage: () => front()?.watch?.first() ?? Promise.resolve(),
    tabs: () => ({ open: list !== undefined }),
    tabKey,
  });
  // A BaseWindow does not close its views' pages; they close here or with the scope.
  window.on("closed", () => {
    const pages = [...tabs.values()].map((tab) => tab.view);
    tabs.clear();
    for (const view of [local, waiting, strip, ...pages]) {
      if (view !== undefined && !view.webContents.isDestroyed()) view.webContents.close();
    }
  });

  yield* Effect.promise(() => local.webContents.loadURL(LOCAL_ENTRY));
  if (waiting !== undefined) {
    const view = waiting;
    yield* Effect.promise(() => view.webContents.loadURL(`${LOCAL_ENTRY}#waiting`));
    coverLoaded = `${LOCAL_ENTRY}#waiting`;
  }
  if (strip !== undefined) {
    const view = strip;
    yield* Effect.promise(() => view.webContents.loadURL(`${LOCAL_ENTRY}?view=tabs`));
  }
  if (options.showOnLoad()) window.show();
  if (first !== undefined && firstAddress !== undefined) {
    yield* loadRemote(window, first.view, firstAddress, options.whenReachable);
  }
  return window;
});

// The strip's requests: the tabs' state, and what it asks for. Only a frame of the app's own
// files may ask (isLocalSender).
const serveTabs = (handlers: {
  readonly view: () => TabsView;
  readonly command: (command: TabCommand) => void;
}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Electron.ipcMain.handle(TABS_CHANNEL, (event) => {
        if (!isLocalSender(event)) throw new Error("refused: not a local window of the app");
        return handlers.view();
      });
      Electron.ipcMain.handle(TAB_COMMAND_CHANNEL, async (event, argument: unknown) => {
        if (!isLocalSender(event)) throw new Error("refused: not a local window of the app");
        handlers.command(await Effect.runPromise(decodeTabCommand(argument)));
      });
    }),
    () =>
      Effect.sync(() => {
        Electron.ipcMain.removeHandler(TABS_CHANNEL);
        Electron.ipcMain.removeHandler(TAB_COMMAND_CHANNEL);
      }),
  );
