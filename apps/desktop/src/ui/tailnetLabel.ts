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
  // A running node's addresses, each on its own line below the row, so the name keeps its width.
  readonly addresses?: ReadonlyArray<string>;
  readonly detail?: TailnetDetail;
}

export const tailnetLabel = (status: TailnetStatus, text: Text): TailnetLabel => {
  switch (status.state) {
    case "running":
      return { state: text.running, addresses: status.addresses };
    case "stopped": {
      const files = status.files;
      if (status.reason === "no-keystore") {
        return { state: text.stopped, detail: { text: text.noKeystore } };
      }
      if (files !== undefined) {
        switch (status.reason) {
          // Nothing is deleted for a file a person can repair.
          case "key-inaccessible":
            return {
              state: text.stopped,
              detail: { text: text.keyInaccessible.lead, files: [files.keyFile] },
            };
          case "key-not-saved":
            return {
              state: text.stopped,
              detail: { text: text.keyNotSaved.lead, files: [files.keyFile] },
            };
          // Deleting both files is the last step: the node signs in again as a new device.
          case "key-unreadable":
          case "state-unreadable": {
            const advice =
              status.reason === "key-unreadable" ? text.keyUnreadable : text.stateUnreadable;
            return {
              state: text.stopped,
              detail: {
                text: advice.lead,
                files: [files.keyFile, files.stateDirectory],
                ...(advice.after === undefined ? {} : { after: advice.after }),
              },
            };
          }
          case undefined:
            break;
        }
      }
      return { state: text.stopped, detail: { text: status.problem } };
    }
    case "starting":
    case "needs-login":
      return { state: text[status.state] };
  }
};
