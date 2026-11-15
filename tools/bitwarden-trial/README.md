# Bitwarden trial

This trial gathers evidence for issue #8 and the proposed `docs/adr/0004-bitwarden-extension.md`. It is not part of Lazurio App. It runs Bitwarden's own Chromium build in Electron 44 with [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell) 4.10.0 (MIT), under the operating system's sandbox, the way a remote view of the app would load it.

`.github/workflows/bitwarden-trial.yml` runs it on Linux, macOS and Windows. A run:

1. downloads `dist-chrome-2026.10.2.zip` from Bitwarden's release `browser-v2026.10.2` and checks it against the pinned SHA-256;
2. starts this directory with the app's own Electron (`main.ts`, run directly by Electron's Node 24);
3. writes `result.json`, `page.png` and `popup.png` as the job's artifact.

`result.json` answers four questions:

- whether Bitwarden's service worker runs past the `chrome.webNavigation` that stock Electron lacks;
- whether its popup shows its first screen;
- whether its content scripts reach a sign-in form on a page;
- what that page sees of the extension machinery.

No request leaves loopback: the trial contacts no Bitwarden server and uses no account and no vault.

Bitwarden's extension is GPL-3.0. The trial downloads it at run time, and nothing of it enters this repository.
