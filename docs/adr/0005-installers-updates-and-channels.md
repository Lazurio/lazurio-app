# 0005 — Installers, self-updates and the stable and nightly channels

- **Status:** accepted
- **Decided:** 2026-11-15 by Matěj Suchánek: two channels, nightly and stable, after T3 Code; Windows right away, the Mac on test builds until the Developer ID. The version numbers were decided by the coordinating thread on the recommendation of this ADR, as Matěj asked to be asked only about important choices ([#16](https://github.com/Lazurio/lazurio-app/pull/16#issuecomment-6900362821)).
- **Related:**
  - decisions 0241 and 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md): one identity `io.lazurio.app`, the same signing identities and the same update channel for GEN4 and GEN5;
  - [ADR 0001](0001-technological-foundation.md) (Electron Fuses, supply chain, CI) and [ADR 0003](0003-node-state-sealed.md) (keys sealed by the system's keystore);
  - T3 Code's updater and release train, which this follows: `apps/desktop/src/updates/DesktopUpdates.ts`, `apps/desktop/src/electron/ElectronUpdater.ts`, `.github/workflows/release.yml` and `release-desktop.yml` in [Lazurio/t3code](https://github.com/Lazurio/t3code).

## Context

Lazurio App GEN4 has to install on a Mac and on Windows, update itself and have a stable and a nightly channel like T3 Code. GEN5, built in the fork of T3 Code, will arrive as an update of the same installed app, without a new install and without asking macOS for its permissions again (0248). Whatever GEN4 ships as its installer, feed and versions is therefore a contract GEN5 has to honour.

Three facts shape the design:

- **Squirrel.Mac installs only a signed update.** Electron's updater on macOS refuses an app without a Developer ID signature. Lazurio's Apple Developer ID is not there yet; Apple has not confirmed when.
- **macOS ties more than updates to the signature.** It keeps the Accessibility and Screen Recording permissions, and the access to the Keychain item that `safeStorage` uses (ADR 0003, cookie encryption), with the app's designated requirement: its identity and its signing team. An unsigned or ad-hoc signed build has no stable requirement, so every new build is a stranger to macOS.
- **Windows SmartScreen warns about an unsigned installer** until the publisher has a reputation, and company antivirus may block it. Windows itself lets an unsigned app update itself. DPAPI, which `safeStorage` uses there, is tied to the Windows user, not to the signature.

## Decision

### 1. Installers

| System  | First install                                                                          | What updates use                                                 | Architectures                         |
| ------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| macOS   | `.dmg`                                                                                 | `.zip` (Squirrel.Mac needs it) and blockmap                      | `arm64` and `x64`, one build each     |
| Windows | NSIS installer, per user, without administrator rights, into `%LOCALAPPDATA%\Programs` | the same NSIS installer, with blockmap for differential download | `x64`; `arm64` once a runner tests it |
| Linux   | not shipped (GEN4 is macOS and Windows)                                                | AppImage, only for the update test in CI                         | `x64`                                 |

- One build per macOS architecture, as T3 Code does, because both helpers are native binaries. The feed for macOS lists both, and electron-updater picks the one of the running machine. An Intel build on Apple Silicon moves to `arm64` on its next update without differential download, as T3 Code does.
- Per-user NSIS needs no administrator, so a person installs it without IT and the app can update itself without a prompt. A per-machine install for managed fleets is a later choice.
- `productName` stays `Lazurio App` and `appId` stays `io.lazurio.app` forever. The main process also fixes the name of the data folder (`userData`) to `Lazurio App` in code, so that no change of `productName` or of the GEN5 build can move it.

### 2. The feed: GitHub Releases of `Lazurio/lazurio-app`

- Every release is a GitHub Release of this repository, with the installers, the update packages, their blockmaps and the update metadata. electron-builder already names the feed (`publish: github`), and the packaged app carries it in `app-update.yml`.
- Metadata files per channel, as T3 Code:
  - stable: `latest.yml` (Windows) and `latest-mac.yml` (both macOS architectures in one file);
  - nightly: `nightly.yml` and `nightly-mac.yml`.
- The release workflow builds each system and architecture in its own job and merges the per-architecture metadata of macOS (and later Windows) into one file per channel, as `release-desktop.yml` does in T3 Code.
- A release is published only once every asset is attached: it is created as a draft and published in one step at the end. A published release is never edited or overwritten; a broken one is withdrawn and replaced by a higher version.
- **GEN5 publishes to the same feed.** Installed GEN4 apps read this repository's releases. GEN5, built in the fork, publishes its first release here (or a GEN4 release first moves the feed to a new place, since an update may carry a new `app-update.yml`).

### 3. Versions and channels

- **Stable** is `X.Y.Z`. **Nightly** is `X.Y.Z-nightly.YYYYMMDD.N`, where `X.Y.Z` is the version in `apps/desktop/package.json`, which is the next stable, `YYYYMMDD` the UTC date of the run and `N` the workflow's run number. The same scheme as T3 Code, so SemVer orders every nightly below the stable it leads to and above the stable before it.
- **Nightly runs on a schedule.** The workflow wakes up every 30 minutes (minutes 8 and 38, away from GitHub's busy minute zero) and releases only when `main` has commits since the last nightly and that nightly is at least six hours old. That is T3 Code's rule, which gives at most four nightlies a day and none on a quiet day.
- **Stable is promoted by hand from nightly.** A manual run of the release workflow builds the commit of the latest published nightly, under that nightly's `X.Y.Z`. Stable therefore only ever ships what nightly users have already run. A stable version may be given by hand only to repeat a promotion.
- **After a stable release** a pull request raises `apps/desktop/package.json` to the next version. The nightly workflow refuses to run while a stable release with the version in `package.json` exists, because its nightlies would sort below that stable.
- **GEN4 stays below `1.0.0`; GEN5 starts at `1.0.0`.** The first release of GEN4 is `0.1.0`.
- **Publishing needs approval.** The jobs that create a release run in GitHub Environments:
  - `lazurio-app-stable` requires an approval on every run. Stable reaches everyone, so until Matěj says otherwise he is its approver: a stable release is a Publication that needs his go-ahead;
  - `lazurio-app-nightly` runs on its own, after T3 Code, once the first nightly was published with Matěj's go-ahead.

  No version goes out before it was verified on real Macs and Windows PCs and Agent Desktop works in the app (plan LZD-0017). Until the first nightly, the schedule only checks, and a run by hand builds without publishing (amended 2026-11-16: building on every schedule without a published nightly would build twice an hour): the repository variable `LAZURIO_APP_NIGHTLY_PUBLISH` is off, and the publishing job is skipped. Turning it on is the Publication of nightly. The fork's `lazurio-release.yml` gates its releases the same way.

- **Provenance.** Each release asset gets a GitHub build provenance attestation from the job that built it, from the exact commit the release names.

### 4. How the app picks its channel

- **A build starts on the channel of its own version:** a nightly build reads `nightly`, a stable build `latest`. T3 Code's `desktopUpdateChannelOf` does the same.
- **The person may switch** in the app's settings, which is a local window. The choice is kept in a settings file in `userData`, read through Schema; a file that does not decode falls back to the build's own channel.
- **No downgrade.** Switching from nightly to stable never installs an older build. The app stays on its nightly until a stable release is higher, as T3 Code's channel floor does. electron-updater's `allowDowngrade` stays off.
- On nightly, `allowPrerelease` is on and `fullChangelog` shows every nightly's notes; on stable both are off, as in T3 Code.
- An Organization pinning its people to stable (T3 Code's managed policy) is not part of this decision.

### 5. When the app checks, downloads and installs

- The updater runs only in a packaged app. It checks 15 seconds after start and then every hour. GitHub serves the feed, and many people behind one office address share its limits, so the app checks less often than T3 Code's four minutes.
- It downloads in the background. The window shows that an update is ready and offers a restart; otherwise the update installs when the person quits the app.
- **Before installing, the updater waits for two things:**
  - **No agent is working on the computer.** The main process gets a service for the Device's activity (LZD-0018, ADR 0006); the updater asks it before it installs and waits while an agent holds the computer. Until that service exists, the updater has a place for it that always answers "free".
  - **The helpers have stopped.** The main process stops every tailnet node and the Device helper by the PIDs it started, and waits for them to exit, before `quitAndInstall`. On Windows a running `.exe` keeps its file locked and the installer would fail. T3 Code stops its backends for the same reason.
- An install that did not apply (the next start still runs the old version) is logged with both versions and shown once in the window.

### 6. What an update keeps

An update replaces the app's files and nothing else. Everything the person has lives in `userData` or in the system's keystore:

| What                                     | Where                                                                        | Kept by an update                           |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| sign-in (cookies, storage)               | the remote views' sessions in `userData`, cookies encrypted by `safeStorage` | yes                                         |
| tailnet nodes                            | `<userData>/tailnets/<tailnet>/state.sealed` and `<tailnet>.key` (ADR 0003)  | yes                                         |
| the Device's key                         | the system's keystore through the main process (LZD-0018, ADR 0006)          | yes                                         |
| the channel and settings                 | settings file in `userData`                                                  | yes                                         |
| macOS Accessibility and Screen Recording | macOS, by identity and signing team                                          | only between builds signed by the same team |

- **Nothing lives beside the binaries.** The helpers keep no state in `resources/helpers`, which an update replaces.
- **On macOS every helper sits inside the bundle,** is signed by the same team and is started by the app's main process, so macOS counts its permissions to `io.lazurio.app`.
- **GEN5 opens the same `userData`, the same Keychain item and the same sealed keys,** because it is the same identity, the same signing team and the same data folder name (point 1).
- The update test (point 9) proves this for every release on Windows and Linux; macOS joins once builds are signed.

### 7. Signing, before and after Lazurio's identities

| System  | Before the identity exists                                                                                                                                                                                                                                                                            | After                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | **No self-update.** The build is ad-hoc signed. The app finds a newer release in the feed and offers to download it in the system's browser; the person replaces the app by hand. After each such update macOS asks again for Accessibility, Screen Recording and the Keychain. Fit for testing only. | Developer ID Application signature, hardened runtime, notarization, stapled. Squirrel.Mac updates by itself. The first signed build asks for the permissions once; every later signed build keeps them.                |
| Windows | Unsigned. The app installs and updates itself; SmartScreen warns at the first install and company antivirus may block it.                                                                                                                                                                             | Signed through the identity the signing thread sets up (Azure Trusted Signing, as T3 Code). From then on the app checks that every update carries Lazurio's publisher (`publisherName`) and refuses one that does not. |

- The workflow signs when the signing secrets exist and builds unsigned otherwise, as T3 Code does, with `CSC_IDENTITY_AUTO_DISCOVERY=false` so that a runner never picks a random identity.
- **The first signed Windows build installs over an unsigned one:** the unsigned app does not check the publisher yet. From then on an unsigned update is refused.
- **On macOS the move to the first signed build is a manual update** (the unsigned app cannot self-update) and asks for the permissions once.
- **Accounts and certificates are not set up here.** That belongs to the thread for signing apps (task 802 of plan LZD-0017). This repository only reads the signing secrets from the GitHub Environment of the release.

### 8. Electron Fuses and the integrity of an update

- **Every update is a whole app, built by CI, carrying the fuses of ADR 0001.** The release workflow runs `check:fuses` on each packaged app before it uploads anything, so no release can loosen a fuse.
- **`EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` stay on.** The app refuses an `app.asar` that does not match the hash built into it, which an update replaces together with the executable.
- **electron-updater checks the SHA-512 of every downloaded package** against the metadata, and differential downloads against the blockmap, before it installs anything.
- **What the app trusts, and what that means today.**
  - The metadata comes over HTTPS from GitHub Releases of this repository. Until the builds are signed, whoever can publish a release here can deliver code to every installed app.
  - Four controls guard that: the approval in the release Environments, CI building from the exact commit, the provenance attestations, and published releases that are never edited.
  - Signing adds the check of the system (Squirrel.Mac's designated requirement on macOS, `publisherName` on Windows), which no one without the signing identity can pass.

### 9. The update test: build N to N+1

- **In CI, on every pull request that changes the updater, the packaging or the release workflows,** and before every release:
  - Windows (NSIS) and Linux (AppImage) build the same commit twice, as `0.0.1` (N) and `0.0.2` (N+1), with the feed of N pointing at a local HTTP server on the loopback that serves N+1's metadata and packages. The versions are stable ones: point 3 offers no other shape (amended 2026-11-15, see below).
  - The test writes a marker into N's `userData` and starts N. N seals a check key with `safeStorage` at its first start (`KeystoreCheck.ts`).
  - It waits for N's log line that the update is downloaded, verified and ready, lets N install it (closing its window on Windows, SIGTERM on Linux), and waits until the app runs again.
  - It checks that the installed app is N+1, that the marker is there and that N+1 opened the key N sealed.
- **The packaged app reads no environment setting** (AGENTS.md). The test feed is therefore baked in at packaging (`publish` of the test build), never read at runtime.
- **macOS joins the test once builds are signed,** because Squirrel.Mac refuses unsigned updates.
- **On real devices** the same N to N+1 runs as part of the QA of task 722 of plan LZD-0017, on a Mac with the permissions granted, to prove they survive.
- **Amendment of 2026-11-15:** this point first named `0.0.1-test.1` and `0.0.1-test.2`. Point 3 offers only `X.Y.Z` and `X.Y.Z-nightly.YYYYMMDD.N`, so the updater would refuse those versions. The test uses `0.0.1` and `0.0.2` instead, which nothing else changes.

## Consequences

- `electron-updater` joins the dependencies at the version the fork locks (6.8.9), under the seven-day rule.
- The main process gets an updater service in the style of the fork's `DesktopUpdates`:
  - a wrapper around `autoUpdater` as an Effect service, as `ElectronUpdater.ts`;
  - Schema for every value from the feed and for the settings file;
  - a small state machine;
  - the install gate of point 5.
- The local window gets the update state and the channel switch through the existing preload bridge. No remote page sees either.
- New workflows:
  - `release.yml`: resolve, preflight, the build matrix through `desktop-platforms.yml`, publish, and stable promotion;
  - `release-desktop.yml`: one system and architecture;
  - the update test.
- `electron-builder.yml` gets the `dmg`, `zip` and `nsis` settings above and, for the test build, the local feed.
- **Windows ships right after its verification. Until Lazurio's Apple Developer ID exists, the Mac gets test builds only:** no self-update, and permissions asked again after each update. People who depend on Agent Desktop on a Mac start on the first signed build.

## Alternatives considered

| Alternative                                     | Why not                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An own update server on Lazurio's domain        | Hosting, certificates and uptime to run for what GitHub Releases give, and a second place to secure. A later GEN4 release can still move the feed, since an update carries its `app-update.yml`. |
| Squirrel.Windows instead of NSIS                | electron-builder's NSIS is the target the fork uses, supports per-user install and differential updates, and keeps one Windows path for GEN4 and GEN5.                                           |
| A universal macOS build                         | Both helpers would need universal binaries (`lipo` of Go and Rust builds) and the download doubles. One build per architecture is what T3 Code ships.                                            |
| A nightly every night at a fixed hour           | T3 Code's rule (every six hours at most, only with new commits) ships fixes the same day without empty releases. The channels stay aligned with T3 Code, as asked.                               |
| Waiting for the Developer ID before any release | Windows can ship and update itself today. The Mac gets test builds with manual updates until signing, which keeps GEN4 moving.                                                                   |
