# 0004 — The remote views may run Bitwarden's extension, and only it

- **Status:** proposed
- **Proposed:** 2026-11-15, for [#8](https://github.com/Lazurio/lazurio-app/issues/8)
- **Related:**
  - decision 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md) ("A person can add the Bitwarden browser extension, through which people use their vault");
  - decision 0203 (each Organization's Lazurio Vaultwarden, reachable only from the tailnet);
  - [ADR 0001](0001-technological-foundation.md) point 4, which this ADR amends, and [ADR 0002](0002-sign-in-pages.md);
  - the trial in [`tools/bitwarden-trial`](../../tools/bitwarden-trial/README.md).

## Context

Stock Electron 44 cannot run Bitwarden's extension (#8). Its service worker stops at the missing `chrome.webNavigation`, and its popup waits without end. [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell) 4.10.0 (MIT) adds the missing APIs to a session.

**What the trial shows.** `tools/bitwarden-trial` runs Bitwarden's own build 2026.10.2 with the library in Electron 44.10.1 (Chromium 152), under each system's sandbox. The results on Linux, macOS and Windows (run [43733971184](https://github.com/Lazurio/lazurio-app/actions/runs/43733971184), 2026-11-15):

- The service worker runs, and the popup shows its first screen ("Security, prioritized … Create account | Log in").
- The content scripts run on a sign-in page and in a frame of it.
- The service worker injects autofill into both: each has Bitwarden's own JavaScript world, holding the autofill object of `bootstrap-autofill*.js`.
- The page gets none of the machinery: `electron`, `ipcRenderer`, `require` and `process` are undefined, and `chrome` is an empty object.
- The only request out went to `https://api.bitwarden.com`, which the trial refuses.
- The extension's ID differed on each system. Bitwarden's build carries no `key`, so Electron derives the ID from the folder it loads. The extension's storage, with the signed-in account and the settings, belongs to that ID.
- Not shown, because each needs an account: a signed-in vault, the inline menu, saving a login and passkeys.

**Where the library goes against ADR 0001.** The library's code in 4.10.0 (`dist/cjs/index.js`, `dist/chrome-extension-api.preload.js`) shows three conflicts:

1. **A preload in remote pages.** The library registers its preload for the pages and service workers of the session (`registerPreloadScript`). The preload gives Chrome's APIs only to `chrome-extension://` pages and service workers. In a remote page it does nothing more.
2. **A message trusts the extension it names.** `crx-msg` takes the extension's ID from the message and never checks who sent it. Its handlers include `cookies.get`, `getAll`, `set` and `remove`, and they require no permission. A remote page with a compromised renderer could name Bitwarden's ID and read every cookie of the remote session, which holds the sign-ins to all Environments. Site isolation is there to prevent exactly that.
3. **Tabs and windows.** Bitwarden opens tabs and windows (`chrome.tabs.create`, `chrome.windows.create`), for example for its web vault and its pop-out. ADR 0001 lets no page open a window.

**What the app's hardening would block.** Every permission is refused, so Bitwarden's pages could not use the clipboard. The navigation guard refuses a `chrome-extension://` frame in a remote view. Bitwarden's inline menu and its bar for saving a login are such frames (`overlay/menu*.html`, `notification/bar.html`), so they would never show.

## Decision

1. **One extension only: Bitwarden's, and only once the person switches it on.**
   - The switch is in a native window of the app, like the Device's capabilities, and it is off by default.
   - The app loads Bitwarden into the remote session (`persist:lazurio-remote`), so one sign-in to the vault serves every Environment.
   - It never loads another extension, one from the Chrome Web Store, or one from a folder of the person's.
2. **Bitwarden's build comes with the app, pinned.**
   - The app bundles Bitwarden's release `browser-v<version>`. Like every other dependency, it is pinned by its SHA-256 and at least seven days old. A new Bitwarden comes with a new app.
   - Its manifest gets a `key` of the app's own. The ID is then the same on every system and stays the same across updates, and so does the extension's storage. That line is the only change to Bitwarden's code.
   - Bitwarden is GPL-3.0. The app ships its licence and points to its source, which is Bitwarden's tag plus the `key` line ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)).
3. **A message must come from the extension it names.**
   - A patch of the library makes `onExtensionMessage` refuse a message unless its sender is a frame at `chrome-extension://<ID>/` or the service worker of that scope. The patch goes in `patchedDependencies`, like the fork's patch of `@effect/vitest`.
   - The same patch requires the `cookies` permission for `cookies.*`, as Chrome does. Bitwarden does not ask for it.
   - The fix goes to the library upstream as well.
4. **Bitwarden's pages, each one named:**
   - **The popup** opens from the app's own button in the tab strip. It opens in a native window of its own view kind, which loads only `chrome-extension://<ID>/` addresses. The app does not register the library's `crx://` protocol, which only serves the library's own toolbar.
   - **Frames in a remote view:** a subframe may also show Bitwarden's `overlay/menu.html`, `overlay/menu-button.html`, `overlay/menu-list.html` and `notification/bar.html`. Nothing else of `chrome-extension:` loads there.
   - **`tabs.create` and `windows.create`:** an address outside Lazurio goes to the system's browser, and a page of Bitwarden's own opens in its native window. Anything else is refused.
   - **Permissions:** Bitwarden's own pages get the clipboard, which its manifest asks for (`clipboardRead`, `clipboardWrite`), and nothing else. Remote pages still get no permission at all.
   - **`nativeMessaging`** is refused. It would let an extension start a program on the computer.
5. **ADR 0001 point 4 changes in one place.**
   - "Remote pages get no preload" becomes: remote pages get no preload of the app's own. With Bitwarden on, the library's preload runs in them and gives them nothing.
   - The tests check this on every pull request. In a remote view with Bitwarden on, a page has no `electron`, `ipcRenderer`, `require` or `process`, and its `chrome` is empty. A message from a remote frame that names Bitwarden is refused.

## Why

- **Not the Chrome Web Store** (`electron-chrome-web-store`). The store would update Bitwarden without review and sooner than seven days, and that code runs in every remote page. A pinned build follows ADR 0001 point 5.
- **A `key`, not a fixed folder.** A copy in a fixed folder of the person's profile would also keep the ID. But it would be one more place outside the app to keep current and to protect. With the key, Bitwarden stays among the app's files, which an update replaces as a whole.
- **Not without the extension.** Without it, a person copies each password from Bitwarden's desktop app. 0248 asks for the extension, and the trial shows it runs.

## Consequences

- **Bitwarden sees every remote page, as it does in Chrome.**
  - Its content scripts read the forms of every Environment's pages, a module's application included.
  - Its service worker has host permissions for every site.

  That is why only Bitwarden's pinned build runs, and only once the person switches it on.

- **Bitwarden reaches its own servers directly.** An Organization's Lazurio Vaultwarden is reachable only from the tailnet (0203). Its name goes through the app's node, like every name the PAC script sends there.
- **What Bitwarden cannot do in GEN4:**
  - its keyboard shortcuts: the library lists them without keys and never sends `chrome.commands.onCommand`;
  - its side panel, which its build ships switched off;
  - unlocking through Bitwarden's desktop app, which needs `nativeMessaging`.
- **A Bitwarden update needs an app release.** A security fix in Bitwarden waits for the next app, at least seven days after Bitwarden's release unless a reviewed exception says otherwise.
- **To verify with a test account before the first release with Bitwarden:**
  - signing in to bitwarden.com, and to a Lazurio Vaultwarden through single sign-on with the Lazurio account;
  - the inline menu and saving a login, on the page and in a frame;
  - passkeys;
  - whether Bitwarden's frames load under `use_dynamic_url`, which its manifest sets;
  - whether any part of Bitwarden expects the Chrome Web Store ID (`nngceckbapebfimnlniiiahkandclblb`) instead of the app's own.
