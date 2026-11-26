import type { TabTitle } from "./tabTitle.ts";

// The one contract between the app's local windows and its main process. Remote pages never see
// it: only the local windows get the preload that exposes it.

export const STATUS_CHANNEL = "lazurio:status";
// The main process sends the whole status again on this channel after every change.
export const STATUS_CHANGED_CHANNEL = "lazurio:status-changed";
// The person picks the update channel and installs a downloaded update (docs/adr/0005, point 4).
export const SET_UPDATE_CHANNEL_CHANNEL = "lazurio:set-update-channel";
export const INSTALL_UPDATE_CHANNEL = "lazurio:install-update";
// Agent Desktop (docs/adr/0006, point 5): its state, every change of it, and Stop.
export const DEVICE_STATE_CHANNEL = "lazurio:device-state";
export const DEVICE_STATE_CHANGED_CHANNEL = "lazurio:device-state-changed";
export const DEVICE_STOP_CHANNEL = "lazurio:device-stop";
// Agent Desktop's Environments and their switches (contract v3): a switch, adding the Environment
// the main window shows, removing one, and signing out of the app's Lazurio account.
export const DEVICE_SET_SWITCH_CHANNEL = "lazurio:device-set-switch";
export const DEVICE_ADD_ENVIRONMENT_CHANNEL = "lazurio:device-add-environment";
export const DEVICE_REMOVE_ENVIRONMENT_CHANNEL = "lazurio:device-remove-environment";
export const DEVICE_SIGN_OUT_CHANNEL = "lazurio:device-sign-out";
// macOS's permissions for Agent Desktop (docs/adr/0006, point 6): the pane of System Settings for
// one kind, and the app's restart once Screen Recording's pane was opened.
export const DEVICE_OPEN_PERMISSION_SETTINGS_CHANNEL = "lazurio:device-open-permission-settings";
export const DEVICE_RESTART_APP_CHANNEL = "lazurio:device-restart-app";
export const STATUS_PANEL_CHANNEL = "lazurio:status-panel";
export const COPY_STATUS_CHANNEL = "lazurio:copy-status";
// What a person without the Organization's network does, in a dialog of the system.
export const NETWORK_HELP_CHANNEL = "lazurio:network-help";
// Copies the sign-in address of a tailnet that waits for sign-in; the address stays in the main
// process.
export const COPY_TAILNET_SIGN_IN_CHANNEL = "lazurio:copy-tailnet-sign-in";
// Loads the Environment's page again from the page that says why it did not show.
export const RETRY_PAGE_CHANNEL = "lazurio:retry-page";
// Leaves that page for the window's first page, the Overview (#68).
export const FIRST_PAGE_CHANNEL = "lazurio:first-page";
// Opens the Agent Desktop window (DevicePanel.ts), from the bar that says an agent works.
export const DEVICE_OPEN_WINDOW_CHANNEL = "lazurio:device-open-window";
// The main window's tabs (#82): their state, every change of it, and what the strip asks for.
export const TABS_CHANNEL = "lazurio:tabs";
export const TABS_CHANGED_CHANNEL = "lazurio:tabs-changed";
export const TAB_COMMAND_CHANNEL = "lazurio:tab-command";

export type HelperStatus =
  | { readonly name: string; readonly state: "ready"; readonly version: string }
  | { readonly name: string; readonly state: "failed"; readonly problem: string };

// The node of one tailnet. Approval of the Device follows the Organization's rules: a node that
// signed in but is not approved stays "running" without reaching any Environment.
export type TailnetStatus =
  | { readonly tailnet: string; readonly state: "starting" }
  | {
      readonly tailnet: string;
      readonly state: "needs-login";
      // Whether the app holds a sign-in address of the node to copy; never the address itself.
      readonly canCopySignIn: boolean;
    }
  | {
      readonly tailnet: string;
      readonly state: "running";
      readonly addresses: ReadonlyArray<string>;
    }
  | {
      readonly tailnet: string;
      readonly state: "stopped";
      readonly problem: string;
      // Why the node did not start, when the person can do something about it (ADR 0003).
      readonly reason?: TailnetStopReason;
      // The node's key file and state directory, which the window names in its advice.
      readonly files?: { readonly keyFile: string; readonly stateDirectory: string };
    };

type TailnetStopReason =
  | "no-keystore"
  | "key-inaccessible"
  | "key-not-saved"
  | "key-unreadable"
  | "state-unreadable";

// How the last navigation of the window's page ended, for Copy status: codes only, never an
// address. `code` is Chromium's network error, `responseCode` the page's HTTP status.
export type PageOutcome =
  | { readonly outcome: "none" }
  | { readonly outcome: "shown"; readonly responseCode: number }
  | { readonly outcome: "waiting"; readonly code: number }
  | { readonly outcome: "failed"; readonly code: number }
  | { readonly outcome: "proxy-refused" }
  | { readonly outcome: "refused"; readonly inBrowser: boolean }
  | { readonly outcome: "crashed"; readonly reason: string };

export type UpdateChannelName = "latest" | "nightly";

// Why the app does not update itself here: an unpackaged app, a Mac without Lazurio's Developer ID,
// or Linux outside an AppImage (docs/adr/0005, point 7).
export type UpdatesOffReason = "unpackaged" | "macos-unsigned" | "linux-not-appimage";

export type UpdateState =
  | { readonly phase: "off"; readonly reason: UpdatesOffReason }
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "downloading"; readonly version: string }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "installing"; readonly version: string }
  // The installer started and the app quits for it.
  | { readonly phase: "restarting"; readonly version: string }
  | { readonly phase: "failed"; readonly problem: string }
  // The chosen channel has no release to update to yet (electron-updater's
  // ERR_UPDATER_LATEST_VERSION_NOT_FOUND or ERR_UPDATER_NO_PUBLISHED_VERSIONS): nothing failed.
  | { readonly phase: "no-release" };

export interface UpdatesStatus {
  readonly channel: UpdateChannelName;
  readonly state: UpdateState;
}

// The channel of one Environment's agents to this computer, as the Device helper reports it.
export type DeviceChannelState =
  | { readonly state: "off" }
  | { readonly state: "connecting"; readonly failedAttempts: number }
  | { readonly state: "connected" }
  // The channel ended and opens again only after the person acts, with the helper's code for why
  // (the Environment refused the computer, or the utility Lazurio Agent Desktop is paired here).
  | { readonly state: "refused"; readonly reason: string }
  // The channel ended and spent its hand-over; it opens again with a new one, with the helper's code
  // for why.
  | { readonly state: "needs-hand-over"; readonly reason: string }
  // An agent works through it: the tool's name and the application, when the engine names one.
  | { readonly state: "working"; readonly tool: string; readonly application: string }
  // The connection to the helper was lost: nobody knows the channel's state any more.
  | { readonly state: "unknown" };

export interface DeviceEnvironmentStatus {
  readonly environmentId: string;
  readonly label: string;
  readonly channel: DeviceChannelState;
}

// Why a switch went off by itself. From Lazurio Auth: the sign-in did not finish, the session ended,
// or the hand-over was refused (404 an unknown Environment, 403 another person's, 409 an Environment
// that cannot take a computer now, "rejected" anything else final). From the Device helper: its
// Refused code. From the app: the Device helper could not take the channel.
export type DeviceSwitchProblem =
  | {
      readonly from: "auth";
      readonly reason:
        | "sign-in-failed"
        | "signed-out"
        | "unknown-environment"
        | "not-permitted"
        | "environment-state-conflict"
        | "rejected";
    }
  | { readonly from: "helper"; readonly reason: string; readonly httpStatus: number }
  // From the app: the Device helper could not take the channel, or did not confirm a channel's stop,
  // so the app ended the helper and confirmed that every engine ended.
  | { readonly from: "app"; readonly reason: "helper-unavailable" | "stop-not-confirmed" };

// Where an Environment's switch is. It is on in every phase but "off".
export type DeviceSwitchPhase =
  | {
      readonly phase: "off";
      readonly problem: DeviceSwitchProblem | null;
      // When the switch went off with its problem (milliseconds since the epoch, the app's clock):
      // the problem is the outcome of that attempt, and the window says from when.
      readonly at?: number;
    }
  // The app waits for the person to sign in in the system's browser.
  | { readonly phase: "signing-in" }
  // The app asks Lazurio Auth for a hand-over.
  | { readonly phase: "connecting" }
  // The Device helper has the channel; its state tells the rest.
  | { readonly phase: "channel" }
  // The app tries again: Lazurio Auth did not answer, or the channel ended and needs a new
  // hand-over.
  | { readonly phase: "retrying"; readonly cause: "auth-unavailable" | "needs-hand-over" }
  // The app asked the helper to close the channel and waits for its confirmation.
  | { readonly phase: "stopping" }
  // The helper did not confirm the stop, and its end could not be confirmed either: nobody knows
  // whether the channel is closed.
  | { readonly phase: "unknown" };

export interface DeviceSwitchStatus {
  // `https://<host>` of the Environment's Lazurio.
  readonly origin: string;
  readonly host: string;
  // The names the Environment's Lazurio gave (shell.json), when the app read them; the window
  // falls back to the name from the address (environmentName.ts).
  readonly name?: string;
  readonly organization?: string;
  readonly switch: DeviceSwitchPhase;
  readonly channel: DeviceChannelState;
  // The person left the switch on: their consent lasts until they turn it off, and the app turns
  // the switch on again at its next start, also while it is off now with a problem.
  readonly consent?: true;
}

// The two permissions of macOS that Agent Desktop's engine needs (docs/adr/0006, point 6).
export type DevicePermissionKind = "accessibility" | "screen";

// Whether each is allowed now, as macOS says without asking. macOS applies a newly allowed Screen
// Recording only to a new process, so "not allowed" may mean "allowed, waits for a restart".
export interface DevicePermissions {
  readonly accessibility: boolean;
  readonly screen: boolean;
  // The person opened Screen Recording's pane in this run of the app.
  readonly screenPaneOpened: boolean;
}

// Agent Desktop on this computer (docs/adr/0006). "absent": this build runs no Device helper;
// "failed": the helper did not start or refused its configuration; "lost": the app lost its
// connection to the helper without stopping it, and cannot reach it any more.
export interface DeviceStatus {
  readonly state: "absent" | "starting" | "ready" | "failed" | "lost";
  readonly environments: ReadonlyArray<DeviceEnvironmentStatus>;
  // The Environment whose agent works on the computer now, if one does; "unknown" once the
  // connection was lost and nothing confirmed that every agent's work ended.
  readonly agent: { readonly environmentId: string; readonly label: string } | null | "unknown";
  // The app's own Lazurio account (its sign-in with Lazurio Auth).
  readonly account: "signed-in" | "signed-out";
  // The account's name from the sign-in's ID token, when it carried one.
  readonly accountName?: string;
  // The Environments the person added, each with its switch, off after every start.
  readonly switches: ReadonlyArray<DeviceSwitchStatus>;
  // The origin of the Environment the main window shows, when it is not in the list yet.
  readonly addable: string | null;
  // Only on a Mac, after a click on a switch in this run found a permission missing, and until
  // both are allowed: the switch stayed off.
  readonly permissions?: DevicePermissions;
}

export interface AppStatus {
  readonly appVersion: string;
  readonly generation: "GEN4";
  readonly helpers: ReadonlyArray<HelperStatus>;
  readonly tailnets: ReadonlyArray<TailnetStatus>;
  // A stable build with neither IT's policy nor the person's setting: no network of the
  // Organization, and none joined in its place.
  readonly networkMissing: boolean;
  readonly updates: UpdatesStatus;
  readonly page: PageOutcome;
}

// The strip of the main window's tabs, as the main process gives it: no address, only each
// tab's name from its address (tabTitle.ts).
export interface TabsView {
  readonly tabs: ReadonlyArray<{
    readonly id: number;
    readonly title: TabTitle;
    readonly loading: boolean;
  }>;
  readonly active: number;
  // Whether a tab can close; the window keeps one tab at least.
  readonly canClose: boolean;
  // Where the tab in front can go in its history.
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

// What the strip asks for; the main process decodes it (TabCommandSchema in MainWindow).
export type TabCommand =
  | { readonly _tag: "Activate"; readonly id: number }
  | { readonly _tag: "Close"; readonly id: number }
  | { readonly _tag: "New" }
  | { readonly _tag: "Back" }
  | { readonly _tag: "Forward" }
  | { readonly _tag: "Reload" };

export interface LazurioBridge {
  readonly status: () => Promise<AppStatus>;
  // Calls the listener with the whole status after every change; the result stops it.
  readonly onStatus: (listener: (status: AppStatus) => void) => () => void;
  readonly setUpdateChannel: (channel: UpdateChannelName) => Promise<void>;
  // Installs a downloaded update: the app restarts once no agent works on the computer.
  readonly installUpdate: () => Promise<void>;
  // Shows or hides the app's status column beside the page.
  readonly setStatusPanel: (shown: boolean) => Promise<void>;
  // Copies the app's status as text without secrets (statusText.ts) to the clipboard.
  readonly copyStatus: () => Promise<void>;
  // Says in a dialog of the system why the Organization's network is missing and what to do.
  readonly showNetworkHelp: () => Promise<void>;
  // Copies the sign-in address of a tailnet that waits for sign-in to the clipboard; fails when
  // the app holds none.
  readonly copyTailnetSignIn: (tailnet: string) => Promise<void>;
  // Loads the Environment's page again; settles once the attempt has shown or failed.
  readonly retryPage: () => Promise<void>;
  // Loads the window's first page, the Overview, instead; settles like retryPage.
  readonly firstPage: () => Promise<void>;
  // Agent Desktop. Only the app's local windows have it, never a remote page.
  readonly device: DeviceBridge;
  readonly tabs: TabsBridge;
}

interface TabsBridge {
  readonly getState: () => Promise<TabsView>;
  // Calls the listener with the whole state after every change; the result stops it.
  readonly subscribe: (listener: (view: TabsView) => void) => () => void;
  readonly command: (command: TabCommand) => Promise<void>;
}

interface DeviceBridge {
  readonly getState: () => Promise<DeviceStatus>;
  // Calls the listener with the whole state after every change; the result stops it.
  readonly subscribe: (listener: (status: DeviceStatus) => void) => () => void;
  // Stop: ends the work of the agent that holds the computer now.
  readonly stop: () => Promise<void>;
  // Only a click in this native window turns a switch on (docs/adr/0006, point 5).
  readonly setSwitch: (origin: string, on: boolean) => Promise<void>;
  // Adds the Environment the main window shows; `origin` is the one this window offered.
  readonly addEnvironment: (origin: string) => Promise<void>;
  readonly removeEnvironment: (origin: string) => Promise<void>;
  // Signs out of the app's Lazurio account and turns every switch off.
  readonly signOut: () => Promise<void>;
  // Opens the Agent Desktop window, or brings it to the front.
  readonly openWindow: () => Promise<void>;
  // macOS only: opens the pane of System Settings for that permission.
  readonly openPermissionSettings: (kind: DevicePermissionKind) => Promise<void>;
  // macOS only, once Screen Recording's pane was opened: starts the app again.
  readonly restartApp: () => Promise<void>;
}
