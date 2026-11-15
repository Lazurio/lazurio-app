# 0006 — Lazurio Agent Desktop inside Lazurio App GEN4

- **Status:** proposed
- **Proposed:** 2026-11-15
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
   - Its crates follow this repository's rules: exact versions, `Cargo.lock` committed, no crate release younger than seven days, `cargo deny`, `unsafe_code = "forbid"` outside the platform calls the process tree needs, and clippy with `-D warnings`.
   - The engine stays a separate binary, built in CI from the commit of the fork pinned in `helpers/device/engine.ref`, and lies next to `lazurio-device` in `resources/helpers`. The helper starts it, talks MCP with it over its standard input and output, and ends it with everything it started.
   - The helper keeps nothing next to its binary, because an update replaces the whole package (ADR 0005). It keeps its files, the list of paired Environments without secrets and `history.jsonl` without content, in the directory the main process gives it inside `userData`.

2. **The main process and the helper speak a new package, `lazurio.app.device.v1`.**
   - It joins the envelope of `lazurio.app.helper.v1` from field 20 on, after the tailnet's fields. Nothing is renumbered and `buf breaking` against `main` must pass.
   - From the main process: `ConfigureDevice` (the data directory, the computer's name), `StartChannel` (the Environment, its attach address, the device id, the key and, when the Environment is reached through the app's tailnet node, the tailnet proxy and its credentials), `StopChannel`, `StopAgent` (Stop) and `ListHistory`.
   - From the helper, also unsolicited with `request_id` 0: `ChannelState` (off, connecting, connected, refused with a reason, working with the tool's name and the app it works in), `LockState` (who holds the computer) and `HistoryPage`.
   - The key is the 32-byte Ed25519 seed. The main process keeps it only sealed by the system's keystore with `safeStorage`, as ADR 0003 does for a node's state key, and gives it to the helper in `StartChannel`. The helper holds it in memory, zeroed on drop, and never writes it.
   - The helper still listens on nothing.

3. **The channel is contract v1, unchanged.**
   - `wss://<the Environment's Lazurio host>/.lazurio/computers/attach?device=<id>`, the challenge signed with `lazurio-computer-attach-v1`, pings every 15 s, the end after 45 s without an answer, reconnection with back-off only while the switch is on, then one MCP message per text frame. The Environment's side is #943, which passes the gateway through the exception for this one path.
   - When the app is a node of the Environment's tailnet, the helper connects through the tailnet helper's loopback proxy with the credentials of its current start, which only the main process knows and gives to it. The computer then needs no Tailscale of its own. Otherwise it connects directly, as the utility does today with the system's Tailscale. The proxy stays closed to pages: a view still gets no proxy credentials, and this is the app's own process.
   - The move to a short-lived credential from Lazurio Auth (0247, 0248) is a later change of contract together with the Environment's side; the first version does not wait for it.

4. **Pairing follows #943 as it is, and never turns a switch on.**
   - In the native window the person enters the address of their Environment's Lazurio. The main process makes the key, listens once on `127.0.0.1:<random port>` for at most ten minutes with a random `state`, and opens `/connect/computer?name&os&pubkey&callback&state` in the system's browser, where the person is signed in to Lazurio. It accepts exactly one answer with the same `state`, then closes the port. This listener belongs to the main process for the length of one pairing, not to a helper.
   - After pairing the Environment appears in the native window with its switch off. Only the person's click in the native window turns it on (ADR 0001, point "Pages hold no power"); the Launchpad page that approved the pairing cannot.

5. **The switches and the agent's activity live only in native windows.**
   - A local window, `Agent Desktop`, lists the paired Environments. Each has its switch (off by default), Stop, Remove (deletes the key here, and links to Lazurio to remove the computer there) and the history without content.
   - The app's icon in the menu bar (macOS) or notification area (Windows) shows the state in three steps: no channel, connected, an agent working. The tooltip and the window say which Environment's agent, which tool and which app.
   - The bridge of the preload gains only the calls this window needs. No remote view ever gets them, and the end-to-end tests check that a remote page reaches none of them.
   - Commands on the computer (`lazurio_shell_*` in the utility) do not come in the first version. They need a second switch and their own confirmation, and the people waiting need the apps, not a shell.

6. **macOS permissions belong to `io.lazurio.app`.**
   - The engine needs Accessibility and Screen Recording. Because the app's main process starts the helper and the helper starts the engine, macOS attributes both to Lazurio App, as long as both binaries lie inside the bundle and carry the app's signing team.
   - The native window checks both (`systemPreferences.isTrustedAccessibilityClient`, `getMediaAccessStatus("screen")`), opens the right pane of System Settings and says that Screen Recording needs the app to restart. It asks only when the person first turns a switch on, not at the app's first start.
   - Windows needs no such permission. UI Automation works only in the signed-in person's session, so a locked computer cannot be used.

7. **Updates wait for the agent.** The updater of ADR 0005 installs an update only when no agent holds the computer. The main process exposes that state from `LockState` as one service the updater reads; the helper refuses new tool calls with a plain error while the app quits for an update.

## What an unsigned app means

The first builds may be unsigned while the Apple Developer ID and the Windows signing are being set up. For this capability that has concrete costs:

- **macOS keeps permissions with the code signature.** An unsigned or ad-hoc signed build gets a new identity with every build, so after every new version the person grants Accessibility and Screen Recording again. A Keychain item sealed by one build may also ask for consent after the next.
- **macOS does not update an unsigned app by itself** (Squirrel.Mac requires a signature), so a new version means downloading and installing it again. Gatekeeper refuses the first start until the person allows it under System Settings → Privacy & Security.
- **Windows** shows SmartScreen ("unknown publisher") at installation. The app then runs normally and UI Automation does not depend on the signature.
- **Trust in the download** rests on where it comes from: only the GitHub Release of this repository, with SHA-256 checksums in the release. That is enough for a pilot with named people, not for distribution.

So an unsigned build is fit for a pilot on Windows at once, and on macOS only for a pilot that accepts granting the permissions again after each version. Signed builds are a condition of anything wider.

## Steps

Each step is one small pull request with targeted tests and a review on its exact head:

1. this ADR;
2. the protocol `lazurio.app.device.v1` and the helper's answers to it over a fake Environment;
3. the core in `helpers/device`: keys, channel, lock, history and the MCP tap, with the utility's tests;
4. the engine: its pinned build in CI, its place in `resources/helpers`, the helper starting and ending it;
5. the main process: the device service in Effect, the key sealed with `safeStorage`, pairing, and the state for the updater;
6. the native window, the icon's states and the macOS permission guide, with end-to-end tests that a remote page reaches none of it;
7. a trial on macOS and Windows against Lazurio Example, recorded in the pull request, before any build goes to people.

## Alternatives considered

| Alternative                                                               | Why not                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship the utility v0 as it is and move the core later                      | Two apps on one computer, two pairings, two sets of permissions on macOS, and a lock that does not span processes (the utility's lock is in its own process), so two agents could work at once. |
| The helper keeps the key in the keystore itself (the utility's `keyring`) | The app already has one way to keep keys, through `safeStorage` in the main process (ADR 0003). A second one means a second consent prompt on macOS and a second place to audit.                |
| Pairing in the app's remote view instead of the system's browser          | The redirect to `127.0.0.1` is outside Lazurio, so the navigation guard rightly hands it to the system's browser. Widening the guard for it weakens a boundary for no gain.                     |
| A custom scheme (`lazurio-app://`) as the pairing callback                | Cleaner, but it changes the contract #943 implements and is already approved. It fits the later move to Lazurio Auth.                                                                           |
| Pairing turns the switch on, as in the utility                            | Decision 0248 and ADR 0001 keep switching a capability on to a native window; the Launchpad page is a page.                                                                                     |
