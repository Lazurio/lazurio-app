import type { TailnetStatus } from "../shared/bridge.ts";
import type { Text } from "./messages.ts";

// What the local window shows for one tailnet: its state, and for a stopped one what the person
// can do about it, or the helper's own words when there is nothing to do (ADR 0003).
interface TailnetDetail {
  readonly text: string;
  // The files to delete, each on its own line so that it reads and copies whole.
  readonly files?: ReadonlyArray<string>;
  readonly after?: string;
}

export interface TailnetLabel {
  readonly state: string;
  readonly detail?: TailnetDetail;
}

export const tailnetLabel = (status: TailnetStatus, text: Text): TailnetLabel => {
  switch (status.state) {
    case "running":
      return { state: `${text.running} · ${status.addresses.join(", ")}` };
    case "stopped": {
      const recovery = status.recovery;
      const instructions =
        status.reason === "key-unreadable"
          ? text.keyUnreadable
          : status.reason === "state-unreadable"
            ? text.stateUnreadable
            : undefined;
      if (status.reason === "no-keystore") {
        return { state: text.stopped, detail: { text: text.noKeystore } };
      }
      if (instructions !== undefined && recovery !== undefined) {
        return {
          state: text.stopped,
          detail: {
            text: instructions.lead,
            files: [recovery.keyFile, recovery.stateDirectory],
            after: instructions.after,
          },
        };
      }
      return { state: text.stopped, detail: { text: status.problem } };
    }
    case "starting":
    case "needs-login":
      return { state: text[status.state] };
  }
};
