// The one contract between the app's local windows and its main process. Remote pages never see
// it: only the local windows get the preload that exposes it.

export const STATUS_CHANNEL = "lazurio:status";
// The main process sends the whole status again on this channel after every change.
export const STATUS_CHANGED_CHANNEL = "lazurio:status-changed";

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
      // The files that start the node afresh once deleted, for an unreadable key or state.
      readonly recovery?: { readonly keyFile: string; readonly stateDirectory: string };
    };

type TailnetStopReason = "no-keystore" | "key-unreadable" | "state-unreadable";

export interface AppStatus {
  readonly appVersion: string;
  readonly generation: "GEN4";
  readonly helpers: ReadonlyArray<HelperStatus>;
  readonly tailnets: ReadonlyArray<TailnetStatus>;
}

export interface LazurioBridge {
  readonly status: () => Promise<AppStatus>;
  // Calls the listener with the whole status after every change; the result stops it.
  readonly onStatus: (listener: (status: AppStatus) => void) => () => void;
}
