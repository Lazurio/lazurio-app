# 0006 — Lazurio Agent Desktop inside Lazurio App GEN4

- **Status:** proposed
- **Proposed:** 2026-11-15; point 3 and the macOS pilot decided by Matěj Suchánek on 2026-11-15
- **Related:**
  - decisions 0240, 0241, 0247 and 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md);
  - [ADR 0001](0001-technological-foundation.md) (helper protocol, pages hold no power), [ADR 0003](0003-node-state-sealed.md) (keys in the system's keystore), ADR 0005 (installation, updates and channels, proposed in parallel);
  - the utility [Lazurio/lazurio-agent-desktop](https://github.com/Lazurio/lazurio-agent-desktop) (contract v1, tried on macOS 27 and Windows 11 on 2026-11-13, [Lazurio/LazurioPlatform#901](https://github.com/Lazurio/LazurioPlatform/issues/901));
  - the Environment's side: [Lazurio/LazurioPlatform#943](https://github.com/Lazurio/LazurioPlatform/pull/943) (pairing, the attach session, broker) behind the gateway exception for `GET /.lazurio/computers/attach` in Machines.

## Context

The agents of a person's Environment should work in the apps on that person's work computer (desktop Outlook, PowerPoint and the like) on macOS and Windows, without any entry into the computer. The utility Lazurio Agent Desktop proved the mechanism: the computer opens the only connection, a WebSocket to its Environment, proves itself with an Ed25519 key made at pairing, and then serves MCP with the engine [Lazurio/agent-desktop](https://github.com/Lazurio/agent-desktop). The owner's switch is the consent, one agent works at a time, and the history keeps no content.

Decision 0248 puts the Device's capabilities into Lazurio App GEN4 as a Rust helper, with switches only in a native window. `helpers/device` is today a skeleton that answers the handshake. The utility's core (`crates/core`, about 5,000 lines) was written to become that helper. People are waiting for a first version of the app that already carries it, so this ADR picks the shortest path that keeps every boundary of ADR 0001 and does not change the contract the Environment's side already implements.

## Decision

1. **The core runs in `helpers/device`.**
   - The utility's core moves into `helpers/device` in steps: keys, the attach channel with its challenge and pings, the lock of one agent, the history without content, the MCP tap with the app's own tools, and the engine's process tree. Its tests against a fake Environment come with it.
   - Its crates follow this repository's rules: exact versions, `Cargo.lock` committed, no crate release younger than seven days, `cargo deny`, `unsafe_code = "forbid"` (the platform calls the process tree needs are made by established crates, point 8), and clippy with `-D warnings`.
   - The engine stays a separate binary and comes only from a release of the distribution fork, as decision 0241 requires: one protected, immutable tag `vX.Y.Z-lazurio.N` of `Lazurio/agent-desktop` with attested binaries for macOS (Apple silicon and Intel) and Windows x64, never a branch or a bare commit, and this repository never builds the engine from source. The first is `v1.3.1-lazurio.1`, today a candidate in Lazurio/agent-desktop#2; publishing it is a release of the fork with its own review.
   - `helpers/device/engine.lock` names that tag and, for each target, the asset's name and SHA-256. `pnpm build:helpers` downloads the release archives of exactly that tag, verifies each archive's build provenance attestation (`gh attestation verify --repo Lazurio/agent-desktop` with the fork's `.github/workflows/lazurio-release.yml` as signer workflow) and its SHA-256 against the lock, and refuses to package on any mismatch, a missing attestation or a tag that moved. Only then is the binary extracted and placed next to `lazurio-device` in `resources/helpers`; on macOS packaging signs it with the app's team after verification, so that macOS attributes the permissions to `io.lazurio.app`. Changing the engine means a pull request that changes the lock to a newer such tag.
   - The helper keeps nothing next to its binary, because an update replaces the whole package (ADR 0005). It keeps its files in the directory the main process gives it inside `userData`: the list of paired Environments without secrets, and the history without content as size-delimited `HistoryEntry` messages of the helper protocol in `history.pb`, rotated into `history.1.pb` at 1 MiB. Each entry carries a sequence that pages are cut by, and a cut-off last entry is cut from the file before the next write.

2. **The main process and the helper speak a new package, `lazurio.app.device.v1`.**
   - It joins the envelope of `lazurio.app.helper.v1` from field 20 on, after the tailnet's fields. Nothing is renumbered and `buf breaking` against `main` must pass.
   - From the main process: `ConfigureDevice` (the data directory, the computer's name), `StartChannel` (the Environment, its attach address, the device id, the key and, when the Environment is reached through the app's tailnet node, the tailnet proxy and its credentials), `StopChannel`, `StopAgent` (Stop) and `ListHistory`.
   - From the helper, also unsolicited with `request_id` 0: `ChannelState` (off, connecting, connected, refused with a reason, working with the tool's name and the app it works in), `LockState` (who holds the computer) and `HistoryPage`.
   - The key is the 32-byte Ed25519 seed. The main process keeps it only sealed by the system's keystore with `safeStorage`, as ADR 0003 does for a node's state key, and gives it to the helper in `StartChannel`. The helper holds it in memory, zeroed on drop, and never writes it.
   - The helper still listens on nothing.

3. **The channel is contract v1, unchanged.**
   - `wss://<the Environment's Lazurio host>/.lazurio/computers/attach?device=<id>`, the challenge signed with `lazurio-computer-attach-v1`, pings every 15 s, the end after 45 s without an answer, reconnection with back-off only while the switch is on, then one MCP message per text frame. The Environment's side is #943, which passes the gateway through the exception for this one path.
   - When the app is a node of the Environment's tailnet, the helper connects through the tailnet helper's loopback proxy with the credentials of its current start, which only the main process knows and gives to it. The computer then needs no Tailscale of its own. Otherwise it connects directly, as the utility does today with the system's Tailscale. The proxy stays closed to pages: a view still gets no proxy credentials, and this is the app's own process.
   - **Decision 0248 wants this channel to carry a short-lived permission from Lazurio Auth, with no lasting key of the Device kept in the Environment.** That permission does not exist yet. On 2026-11-15 Matěj decided a pilot of named people now ([his answer](https://github.com/Lazurio/lazurio-app/pull/15#issuecomment-6900363040)): until the permission from Auth is deployed, pilot builds of Lazurio App for the people of a named pilot open the channel as the utility does, contract v1 with the Device's key in the Environment's registry (the pairing channel that 0247 names as an exception, as #943 records it), and move to the permission from Auth together with the Environment's side. Writing the exception into 0248 is proposed in [Lazurio/LazurioPlatform#1008](https://github.com/Lazurio/LazurioPlatform/pull/1008); until that addendum is merged, the register does not yet carry it, and no pilot build opens the channel on contract v1 before it is. The coordinator of the pilot keeps the list of its people outside the public repositories, and no build beyond that pilot opens the channel on contract v1.

4. **Pairing follows #943 as it is, takes over the utility's pairing, and never turns a switch on.**
   - **Superseded by contract v3** (see "Contract v3 in the app" below). The app does not pair and does not take over the utility's pairing, its keys or its keystore entries. Instead the Device helper opens no channel while the utility is paired, and the person removes the utility. The rest of this point describes the pilot of point 3 and is not built.
   - In the native window the person enters the address of their Environment's Lazurio. The main process makes the key, listens once on `127.0.0.1:<random port>` for at most ten minutes with a random `state`, and opens `/connect/computer?name&os&pubkey&callback&state` in the system's browser, where the person is signed in to Lazurio. It accepts exactly one answer with the same `state`, then closes the port. This listener belongs to the main process for the length of one pairing, not to a helper.
   - **A computer paired with the utility is not paired again.** The app reads the utility's list of Environments (`environments.json`, no secrets) and takes each Environment's key from the utility's keystore entry (service `io.lazurio.agent-desktop`): on Windows from the Credential Manager of the same signed-in person, on macOS after the person confirms the Keychain's prompt. It seals the key with `safeStorage` like its own. The Environment keeps the same device id and key, so no new approval on the Launchpad page is needed.
   - **One agent on the whole computer, across the utility and the app, enforced by the operating system.** The lock of one agent becomes a lock of the signed-in person's session, not of a process:
     - **The device lock.** Before it serves an agent's tool call, a process must hold the device lock: an exclusive lock on one file of the person's session, `~/Library/Application Support/io.lazurio.device/agent.lock` on macOS (`flock`) and `%LOCALAPPDATA%\io.lazurio.device\agent.lock` on Windows (`LockFileEx`), taken with the standard library's `File::try_lock`, so neither `unsafe` code nor another crate is needed. It holds it for the whole hold of contract v1 (while a tool runs and 20 seconds after the last call), the in-process lock nested inside it. A tool call that cannot take the lock at once is refused with the same error as today ("The computer is in use by an agent from …", here "… from another Lazurio app"). The operating system releases the lock when the process ends, crashes included, so it never stays stuck. Whoever holds it, no other process can issue a single tool call, whatever it has connected: the exclusion is on the work, so no race between startup, pairing and attaching can overlap two agents.
     - **The utility takes the same lock.** A pilot release of the utility takes the device lock in its core, on the same file with the same mechanism (`File::try_lock` on `io.lazurio.device/agent.lock` in the directories above), because a lock on another file or by another mechanism would not exclude the app; and that utility version becomes the oldest one the app tolerates. Before every connection the app reads the version of a utility installed at its exact path on macOS and Windows (read-only, never by name, never stopping it); while an older utility is installed, the app opens no channel and says why. The utility's older pilot builds are taken off its releases before the app's pilot (a step for the coordinator, because it changes what people can download).
     - **The Environment refuses a utility without the lock.** A utility without the device lock (the builds before it) can still be started from any path, also after the app attached and paired anew with another Environment, and the app cannot stop it. The Environment's side therefore closes such a session before it serves any tool: after `ready` the broker reads the computer's answer to `initialize`, and a session that does not announce the device lock (`_meta["io.lazurio/agent-desktop"]` of a utility version below the first one with the lock, or missing or broken metadata) ends with a plain reason. This is a change of Lazurio Platform after #943 that ships before the app's pilot starts, and the pilot starts only for people whose Environments with Agent Desktop all run it. The app announces the lock under its own key.
     - **The takeover is all or nothing,** as a second guard. The app writes a takeover record to `userData`, takes and seals every Environment's key, deletes every utility keystore entry, and only then marks it done. Until then no switch can be turned on, and an interrupted takeover resumes at the next start. A key that cannot be read leaves the takeover open until the person retries or forgets that Environment's utility pairing. Before every connection the app also checks that the utility's keystore holds no entry. The utility reads its key at every connection, so after a takeover it cannot authenticate anywhere.
     - The Environment refuses a second session of the same device (#943), within one Environment.
   - Tests exercise the interleaving itself, with two real processes on the device lock and no timing: while process A holds the lock, B's tool call is refused, before and after B attaches; when A's hold ends, B's next call succeeds; when A is killed while holding, B gets the lock; a tool call of B that arrives while A's call runs is refused. With two Environments A and B: a takeover interrupted after A leaves every switch unavailable until it finishes B; an unreadable key of B keeps them unavailable; an older utility at its path blocks every connection; a utility keystore entry that reappears blocks the next connection. Against a fake Environment with two Environments: with the app attached to A, an old utility started afterwards from another path and paired with B is refused by B before any tool. The trial of step 7 runs the utility with the lock and the app side by side on macOS and Windows, with each attached to a different Environment, and records that only one agent's calls are served at a time.
   - After pairing, or taking a pairing over, the Environment appears in the native window with its switch off. Only the person's click in the native window turns it on (ADR 0001, point "Pages hold no power"); the Launchpad page that approved the pairing cannot.

5. **The switches and the agent's activity live only in native windows.**
   - A local window, `Agent Desktop`, lists the paired Environments. Each has its switch (off by default), Stop, Remove (deletes the key here, and links to Lazurio to remove the computer there) and the history without content.
   - The app's icon in the menu bar (macOS) or notification area (Windows) shows the state in three steps: no channel, connected, an agent working. The tooltip and the window say which Environment's agent, which tool and which app.
   - The bridge of the preload gains only the calls this window needs. No remote view ever gets them, and the end-to-end tests check that a remote page reaches none of them.
   - Commands on the computer (`lazurio_shell_*` in the utility) are the second switch of 0248: per Environment, off by default, switched on only in this window with its own confirmation. They come as their own step after the first pilot build (step 8 below), because the people waiting need the apps first.

6. **macOS permissions belong to `io.lazurio.app`.**
   - The engine needs Accessibility and Screen Recording. Because the app's main process starts the helper and the helper starts the engine, macOS attributes both to Lazurio App, as long as both binaries lie inside the bundle and carry the app's signing team.
   - When the person turns a switch on, the main process reads both without asking (`systemPreferences.isTrustedAccessibilityClient(false)`, `getMediaAccessStatus("screen")`). With one missing the switch stays off, with no sign-in, hand-over or channel, and the window shows both with one button: it lets macOS list the app and opens the pane of the first one missing, and once Screen Recording's pane was opened it restarts the app the way Quit does, because macOS applies Screen Recording only to a new process. The window reads both again while it shows them, and the person turns the switch on again; nothing is asked at the app's first start.
   - Windows needs no such permission. UI Automation works only in the signed-in person's session, so a locked computer cannot be used.

7. **Updates wait for the agent.** The updater of ADR 0005 ([#16](https://github.com/Lazurio/lazurio-app/pull/16), its point 5) installs an update only when no agent holds the computer.
   - The main process offers one service, `DeviceActivity`, built from `LockState`: `isIdle: Effect<boolean>`, `idleChanges: Stream<boolean>`, and `holdForUpdate: Effect<boolean, never, Scope>`. The last one is the updater's gate: it succeeds with `true` only when no agent holds the computer, and from then until its scope closes the helper refuses every new tool call with a plain error ("Lazurio App is updating"), so no agent can start between the check and the installation. With `false` the updater waits for the next `true` from `idleChanges`.
   - **The helper can revoke a granted hold.** When a tool may still be running although the hold was granted (point 8: a tree that cannot be confirmed gone, also one the updater's own shutdown leaves), the helper sends an unsolicited `LockState` (`request_id` 0) with `update_hold` false and not idle, and from then on answers every `HoldForUpdate` with `update_hold` false. The rule for the main process: `DeviceActivity` follows every `LockState`, a revocation ends a granted `holdForUpdate` like a `false`, and the updater installs only while the latest `LockState` says `update_hold` true, checking it again right before it installs.
   - **Every `LockState` carries a `sequence`,** strictly increasing per helper process, assigned under the lock when the snapshot is taken. The helper hands each snapshot, as an answer or on its own, to its writer while still holding the lock, so the main process receives them in sequence order. `DeviceActivity` ignores a `LockState` whose sequence is not greater than the last one it applied.
   - **The updater installs only after the helper confirms that every engine ended.** After `Shutdown`, or the end of its input, the device helper ends every channel and every engine's process tree, then sends `DeviceStopped` (`request_id` 0) as its last message and exits. `all_engines_ended` is true only if every tree was confirmed gone and the helper never kept the computer because a tree could not be confirmed gone. The updater installs only when all four hold:
     1. it held a granted update hold, by the highest-sequence `LockState`;
     2. it sent `Shutdown`;
     3. it received `DeviceStopped` with `all_engines_ended` true;
     4. the helper process exited.

     A missing, false, late (after the two seconds of point 8) or lost `DeviceStopped`, or any revocation of the hold in between, means no installation: the app restarts its helpers instead (fail closed).

   - Until the helper serves this, the service answers idle, and `holdForUpdate` always succeeds.
8. **The helper stops within two seconds.** Before an update replaces `resources/helpers`, and on Windows a running `.exe` keeps its file locked, the main process sends `Shutdown`, closes the helper's standard input and waits; only after that does it end the helper by the PID it started. On `Shutdown`, on the end of its input and on SIGTERM the helper closes its channels and ends the engine with everything it started (a job object on Windows, a process group on macOS), then exits, within two seconds. A test holds it to that.
   - **The engine ends with its whole process tree, and the lock waits for it.** The engine runs each tool as a child process of its own, so ending only the engine would leave a tool working. Whenever the helper ends an engine (Stop, a cancelled tool call, the end of a session, `StopChannel`, `Shutdown`), it ends the whole tree and waits until it is gone. Only then does it release the hold or end the open calls on the lock.
   - **A tree that cannot be confirmed gone closes the helper for good.** If a tree is not gone within one second after its kill, a tool may still be running. From then until the helper process ends, the whole helper, not only that channel, fails closed:
     - the hold and the device lock stay, taken for that Environment if nobody held them;
     - every tool call of every Environment, the same one included, is refused with "Agent Desktop could not confirm that a stopped tool ended. Restart Lazurio App." (in Czech and English);
     - no engine starts again;
     - Stop, `StopChannel` and the end of the hold's time release nothing;
     - `LockState` keeps reporting the holder and never idle, and the updater's hold is revoked if it was granted and refused from then on (point 7), so no update installs while a tool may run.

     The history records one `unconfirmed` entry, without content. Restarting Lazurio App, an update's restart included, ends the helper and with it the state.

   - **No `unsafe` in the helper's own code; established crates make the platform calls** (decided on 2026-11-17 by the owning thread of step 3b-2, in Lazurio/lazurio-app#37):
     - on macOS and Linux the engine starts in a process group of its own (`CommandExt::process_group(0)`). The helper sends SIGKILL to the group, reaps the engine and polls `kill(-pgid, None)` until `ESRCH`, with [`nix`](https://crates.io/crates/nix);
     - on Windows the engine is assigned, right after its start and before it gets any message, to a job object that kills on close, nested in a second job that only watches, with [`win32job`](https://crates.io/crates/win32job). The helper closes the first job and waits until the second lists no process. `win32job` has no call that terminates a job, and calling `TerminateJobObject` directly would need `unsafe`, hence the two jobs.
     - Both crates follow the rules of point 1 (exact versions at least seven days old, licenses within `deny.toml`, minimal features). The tests of the process tree run on macOS and Linux; on Windows the CI builds this code and runs the other engine tests natively.

## What an unsigned app means

The Apple Developer ID and the Windows signing are still being set up (LZD-0017). For this capability an unsigned build has concrete costs:

- **macOS keeps permissions with the code signature.** An unsigned or ad-hoc signed build gets a new identity with every build, so after every new version the person grants Accessibility and Screen Recording again. A Keychain item sealed by one build may also ask for consent after the next.
- **macOS does not update an unsigned app by itself** (Squirrel.Mac requires a signature), so a new version means downloading and installing it again. Gatekeeper refuses the first start until the person allows it under System Settings → Privacy & Security.
- **Windows** shows SmartScreen ("unknown publisher") at installation. The app then runs normally and UI Automation does not depend on the signature.
- **Trust in the download** rests on where it comes from: only the GitHub Release of this repository, with SHA-256 checksums in the release. That is enough for a pilot with named people, not for distribution.

On 2026-11-15 Matěj decided how this applies ([his answer](https://github.com/Lazurio/lazurio-app/pull/15#issuecomment-6900363040)): a pilot on Windows may start with an unsigned build; on macOS only as a trial with the people of the pilot, who know they grant the permissions again after each version and install new versions by hand, and lasting use on a Mac waits for the Developer ID and notarization. Signed builds are a condition of anything wider.

## Steps

Each step is one small pull request with targeted tests and a review on its exact head:

1. this ADR;
2. the protocol `lazurio.app.device.v1` and the helper's answers to it over a fake Environment;
3. the core in `helpers/device`: keys, channel, the device lock across processes, history and the MCP tap, with the utility's tests; the same lock in a pilot release of the utility;
   and in Lazurio Platform, the broker refusing a session without the device lock;
4. the engine: the lock of its fork release, the verified download of its attested assets in `build:helpers` and CI, its place in `resources/helpers`, the helper starting and ending it (after the fork's release `v1.3.1-lazurio.1` exists);
5. the main process: the device service in Effect, the key sealed with `safeStorage`, pairing, taking over the utility's pairing, and the state for the updater (`DeviceActivity`);
6. the native window, the icon's states and the macOS permission guide, with end-to-end tests that a remote page reaches none of it;
7. a trial on macOS and Windows against Lazurio Example, recorded in the pull request, before any build goes to people (on contract v1 only for the named pilot of point 3, once the addendum of #1008 is merged);
8. commands on the computer behind their own switch;
9. the channel with the short-lived permission from Lazurio Auth, together with the Environment's side.

### The first usable build for Windows (2026-11-17)

On 2026-11-17 Matěj asked for a minimal but working Agent Desktop in Lazurio App for Windows as soon as possible, built the way Lazurio will keep it, so not on the pilot exception of point 3. The same day he chose the channel's final design (variant B, HumanAndMachine-ai/Machines#936). It has three locks:

1. **The computer** is an approved device node of the Environment owner in the Organization's tailnet, and the Environment's gateway admits the channel only from such a node.
2. **The person** signs in with the app's own public Lazurio Auth client (PKCE). The app sends the gateway a short-lived token for one Environment, which the gateway's helper checks.
3. **Consent** is the switch on the computer.

There is no device key in Auth and no Environment-side registry of computer keys. The contract between the app, Auth, the gateway and the Platform (contract v3) is written with the threads that build those parts. Point 3's contract v1 and its pairing are not used for this build.

- **In, independent of the channel:**
  - the engine in the Windows package (step 4);
  - the main process following the Device helper (step 5), with the updater's handshake of point 7;
  - the tailnet helper's proxy for an Environment in the app's tailnet;
  - minimal native controls in the window's local column (step 6): the Environments' states and Stop;
  - Stop and every other end of an engine ending its whole process tree (point 8).
- **In, once contract v3 is set:** the app's sign-in and the token per Environment, each Environment's switch, and the Device helper's channel signing in with the token instead of v1's signature.
- **Later:** the icon in the menu bar or notification area, showing the history (the helper keeps writing it), the macOS permission guide, the switch for commands, and macOS builds.
  - **Brought forward for the pilot on Windows (2026-11-18):** the icon in the notification area and the start at the sign-in to Windows. Without them the agent loses the computer as soon as the person closes the window or signs in again.
    - Closing the window hides it on Windows and Linux. The app, its helpers and every switch that is on run on.
    - The icon's menu opens the window or quits. A quit always goes through the app's own end, which installs a downloaded update first and stops the helpers.
    - A packaged app on Windows starts hidden at the person's sign-in (`--hidden`) with every switch off, because the consent lasts one run.
    - One app runs per data folder; a second start shows the first one's window.
    - A Mac keeps the Dock's behaviour and gets neither the icon in the menu bar nor a start at login yet.

### Contract v3 in the app (2026-11-17)

How Lazurio App carries the three locks above (task-2026-11-17-936). There is no pairing, no key of the Device and no entry into the computer.

- **Environments by origin.** An Environment is the origin of its Lazurio, `https://<host>`. The local window offers "Add this Environment" only for the page the main window shows, when that page is HTTPS on a name below `lazurio.io` (`Navigation.environmentOriginOf`). The list lives in `<userData>/agent-desktop-environments.json`. It holds no secret and no switch, and it is replaced whole on every change. Remove takes an Environment off the list. Only Lazurio Auth decides whether the origin is an Environment the person may use: its hand-over answers 404 for an unknown Environment and 403 for another person's.
- **Names only for display (2026-11-19).** To show an Environment and its Organization by name, the app makes one `GET <origin>/.lazurio/shell.json` with the main window's session. This is the same read the Environment's Lazurio page makes, with no header of the app's own and no retry. It happens when the person adds the origin, and when the main window shows an origin already in the list. Only the two names are kept, next to the origin in the list file. No other field of the answer is kept or logged. A name is a label for the app's windows only: the channel's address and its owner come from the origin and Lazurio Auth alone, and the helper's `environment_label` still comes from the address, because a tool error may show it to another Environment's agent. This changes no lock.
- **A switch for one run.** Every switch is off after each start of the app, because the consent lasts one run. Only a click in the app's local window turns one on (`DeviceIpc`), and no remote page has the bridge. The end-to-end tests check both.
- **Sign-in and hand-over.** A switch turned on signs in with the app's own client (`AuthClient`, scope `lazurio-device-entry`) when the app has no session, or when the session it kept is no longer valid at that click. The sign-in opens in the system's browser. The app then asks for a hand-over for the origin and sends `StartChannel` with it, with the tailnet helper's proxy when the host lies in the app's tailnet, and directly otherwise. The hand-over lives only in the main process's memory as `Redacted`. It goes to the helper once, and the app's copy of its bytes is wiped after that. No state for the windows, log or error carries it.
- **`NeedsHandOver`.** While the switch is on, the app asks for a new hand-over after the helper's `retry_after_ms` and sends a new `StartChannel`. This covers the end of a session after 8 hours and `expired`.
- **`Refused` and final answers of Auth.** These turn the switch off, and the window says why in a sentence:
  - the helper's `Refused`;
  - Auth's 403, 404 and 409, or any other final answer of Auth;
  - a refused refresh while the switch is on, which means the person is signed out.

  A 503 or an unreachable Auth is temporary: the app asks again with a back-off from 1 s to 60 s and the switch stays on.

- **Off and sign-out.** Turning a switch off sends `StopChannel`, and Stop still ends the agent's work. Signing out in the local window turns every switch off and ends the session.
- **Off only when confirmed.** A switch shows Off only after the helper answers `StopChannel` with Off for that Environment, and it shows Turning off until then. When that answer does not come within 5 seconds, comes as a failure, or the wait is interrupted, the app fails closed:
  - it ends the whole Device helper with `Shutdown`, then by its PID after two seconds, and with it every channel;
  - only when the process exited and said `DeviceStopped` with every engine ended does every switch say Off, with the reason;
  - otherwise the switches and the agent stay unknown, as after a lost helper, and nothing turns on until the app starts again.

  Removing an Environment and signing out wait for the same confirmation. Without it, Remove keeps the Environment in the list and fails. Sign-out still ends the session, because that opens no channel, but it fails as well.

- **The guard against the utility replaces the takeover of point 4.** The helper opens no channel while the utility Lazurio Agent Desktop keeps an entry of `io.lazurio.agent-desktop` in the system's keystore, and stops an agent when one appears (`agent_desktop_paired`). The window tells the person what to do: remove every Environment in the utility and uninstall it, or, once it is uninstalled, delete those entries in Credential Manager or Keychain Access, then turn the switch on again. The app reads, takes and deletes nothing of the utility.

### Full control of the computer (2026-11-24)

On 2026-11-24 Matěj decided on #108: physical input belongs under the same switch, "either full control of the computer, or none". There is no second consent and no hidden switch.

- **The switch means full control.** The helper always starts the engine as `agent-desktop mcp --headed`. An agent sees the screen, moves the real pointer, clicks and drags at coordinates, types on the keyboard and focuses windows. Before this, the engine ran in its default strict headless mode, which delivers input only through accessibility and refuses pointer moves. The trial switch `LAZURIO_AGENT_DESKTOP_HEADED` of #105 never reached `main`.
- **The window says it in plain words.** Agent Desktop's window says, under its heading, that a switch that is on gives the Environment's agents full control of the computer, with the mouse and the keyboard. Its help tells the person not to use the computer while an agent works, or to stop the agent first.
- **What stays:** the bar with Stop over the page and Stop in the notification area. The status column never opens for an agent's work.
- **A button released after an ended engine (#112).** The helper ends an engine's whole process tree (point 8), so a drag cut off by Stop never releases the mouse button it pressed, and the person's next move would draw on. Once the tree of an engine with physical input is gone, the helper releases the left mouse button itself, on Windows and macOS. A release with no press before it changes nothing.
  - Only the engine that began the last tool call, ended in the middle of a call, can have the button pressed, so only its end releases it. The device lock records which engine began the last call.
  - Every connected Environment has an engine of its own, and a channel the same Environment replaced keeps ending its old engine for a moment, possibly in the middle of a drag. The device lock knows every engine that has not ended, so a tool call of the new channel waits until the old engine has ended and released the button (at most 5 s, then the call is refused as busy). The button never has two engines that pressed it. Stop wakes that wait, and a call waiting when the person pressed Stop is refused and never reaches an engine.
  - Stop takes the device lock, and so do the steps it must not fall between: a call is accepted and handed to its engine in one hold of the lock, and a channel marks its engine as starting in the lock before the process starts, so a Stop that comes during the start waits for that engine as for a running one. A Stop therefore either comes before a call and refuses it, or after it and ends it with its engine, and it never misses an engine. A call the agent sends once the Stop ended is new work, as before: Stop ends the work and frees the computer, and only the switch ends the agent's access.
  - The release happens inside the device lock, before the hold ends, so no other Environment's engine can press the button between the check and the release. An engine whose tree is not confirmed gone may still work, so its end releases nothing.
  - The call is made with [`enigo`](https://crates.io/crates/enigo), following the rules of point 1 and point 8: an exact version, MIT, no default features, and only for Windows and macOS.
  - The cost: a person who holds the left button at the moment an engine ends has that press cut.
  - Not done: cancelling the engine's calls before the kill, so that the engine releases by itself. On Windows the engine kills its tool at once, so that path needs a change of the fork.

## Alternatives considered

| Alternative                                                               | Why not                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship the utility v0 as it is and move the core later                      | Two apps on one computer, two pairings, two sets of permissions on macOS, and a lock that does not span processes (the utility's lock is in its own process), so two agents could work at once. |
| The helper keeps the key in the keystore itself (the utility's `keyring`) | The app already has one way to keep keys, through `safeStorage` in the main process (ADR 0003). A second one means a second consent prompt on macOS and a second place to audit.                |
| Pairing in the app's remote view instead of the system's browser          | The redirect to `127.0.0.1` is outside Lazurio, so the navigation guard rightly hands it to the system's browser. Widening the guard for it weakens a boundary for no gain.                     |
| A custom scheme (`lazurio-app://`) as the pairing callback                | Cleaner, but it changes the contract #943 implements and is already approved. It fits the later move to Lazurio Auth.                                                                           |
| Pair again in the app instead of taking the utility's pairing over        | A second approval on the Launchpad page for every pilot, and a second key in the Environment's registry until someone removes the first.                                                        |
| Pairing turns the switch on, as in the utility                            | Decision 0248 and ADR 0001 keep switching a capability on to a native window; the Launchpad page is a page.                                                                                     |
