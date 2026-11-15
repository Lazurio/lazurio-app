import * as Option from "effect/Option";

import { destinationOf } from "./Navigation.ts";

// The page of the web Lazurio the main window shows. A packaged app takes neither setting. Else the
// end-to-end tests' page comes first, then the development page, as an address of Lazurio over
// HTTPS only. No page leaves the main window with the app's own view alone.
interface RemoteUrlSettings {
  readonly packaged: boolean;
  readonly test: Option.Option<string>;
  readonly development: Option.Option<string>;
}

interface RemoteUrlChoice {
  readonly remoteUrl: Option.Option<string>;
  // A development page was set, and it is no address of Lazurio over HTTPS.
  readonly developmentRefused: boolean;
}

const noPage: RemoteUrlChoice = { remoteUrl: Option.none(), developmentRefused: false };

export const choose = (settings: RemoteUrlSettings): RemoteUrlChoice => {
  if (settings.packaged) return noPage;
  if (Option.isSome(settings.test)) return { remoteUrl: settings.test, developmentRefused: false };
  if (Option.isNone(settings.development)) return noPage;
  return destinationOf(settings.development.value)._tag === "Lazurio"
    ? { remoteUrl: settings.development, developmentRefused: false }
    : { remoteUrl: Option.none(), developmentRefused: true };
};
