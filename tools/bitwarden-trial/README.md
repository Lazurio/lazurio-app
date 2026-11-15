# Bitwarden trial

This trial gathers evidence for issue #8 and the proposed `docs/adr/0004-bitwarden-extension.md`. It is not part of Lazurio App. It runs Bitwarden's own Chromium build in Electron 44 with [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell) 4.10.0 (MIT), under the operating system's sandbox, the way a remote view of the app would load it.

`.github/workflows/bitwarden-trial.yml` runs it on Linux, macOS and Windows. A run:

1. downloads `dist-chrome-2026.10.2.zip` from Bitwarden's release `browser-v2026.10.2` and checks it against the pinned SHA-256;
2. starts this directory with the app's own Electron (`main.ts`, run directly by Electron's Node 24) and a fresh profile outside the artifact;
3. writes `result.json`, `steps.log`, `page.png` and `popup.png` as the job's artifact.

`result.json` answers five questions, and the run fails when any answer is no:

- whether Bitwarden's service worker runs past the `chrome.webNavigation` that stock Electron lacks;
- whether its popup shows its first screen;
- whether its content scripts run on a sign-in page;
- whether its service worker injects autofill into every frame of that page: the page itself and a frame with a second sign-in form;
- whether that page gets none of the extension machinery.

Bitwarden changes a page visibly only with an unlocked vault, so the trial checks the content scripts through DevTools instead. Every frame must have Bitwarden's own JavaScript world, and in it the autofill object that `bootstrap-autofill*.js` creates.

No request leaves loopback: the trial contacts no Bitwarden server and uses no account and no vault.

Bitwarden's extension is GPL-3.0. The trial downloads it at run time, and nothing of it enters this repository.
