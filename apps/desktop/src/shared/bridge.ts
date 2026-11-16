// The one contract between the app's local windows and its main process. Remote pages never see
// it: only the local windows get the preload that exposes it.

export const STATUS_CHANNEL = "lazurio:status";
// The main process sends the whole status again on this channel after every change.
export const STATUS_CHANGED_CHANNEL = "lazurio:status-changed";
// The person picks the update channel and installs a downloaded update (docs/adr/0005, point 4).
export const SET_UPDATE_CHANNEL_CHANNEL = "lazurio:set-update-channel";
export const INSTALL_UPDATE_CHANNEL = "lazurio:install-update";

export type HelperStatus =
  | { readonly name: string; readonly state: "ready"; readonly version: string }
  | { readonly name: string; readonly state: "failed"; readonly problem: string };

// The node of one tailnet. Approval of the Device follows the Organization's rules: a node that
// signed in but is not approved stays "running" without reaching any Environment.
export type TailnetStatus =
  | { readonly tailnet: string; readonly state: "starting" }
  | { readonly tailnet: string; readonly state: "needs-login" }
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
  | { readonly phase: "failed"; readonly problem: string };

export interface UpdatesStatus {
  readonly channel: UpdateChannelName;
  readonly state: UpdateState;
}

export interface AppStatus {
  readonly appVersion: string;
  readonly generation: "GEN4";
  readonly helpers: ReadonlyArray<HelperStatus>;
  readonly tailnets: ReadonlyArray<TailnetStatus>;
  readonly updates: UpdatesStatus;
}

export interface LazurioBridge {
  readonly status: () => Promise<AppStatus>;
  // Calls the listener with the whole status after every change; the result stops it.
  readonly onStatus: (listener: (status: AppStatus) => void) => () => void;
  readonly setUpdateChannel: (channel: UpdateChannelName) => Promise<void>;
  // Installs a downloaded update: the app restarts once no agent works on the computer.
  readonly installUpdate: () => Promise<void>;
}
