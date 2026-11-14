# 0003 — A tailnet node's state is sealed with a key the system's keystore keeps

- **Status:** proposed
- **Proposed:** 2026-11-14, for [#2](https://github.com/Lazurio/lazurio-app/issues/2)
- **Related:** decision 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md) ("which keep their keys in the system's keystore, never in the storage of web views"), [ADR 0001](0001-technological-foundation.md)

## Context

tsnet keeps a node's state in `tailscaled.state` in its directory, in the clear. That state holds the node's machine key and node key. Anyone who can read the person's files can copy them and join the tailnet as that Device. Decision 0248 wants the helpers' keys in the system's keystore.

The whole state does not fit everywhere a keystore takes secrets. A Windows credential holds at most 2,560 bytes, and a node's state is already about 2,400 bytes with one profile. tsnet writes it many times while it runs.

## Decision

1. **Each node's state is one sealed file.**
   - The tailnet helper gives every `tsnet.Server` its own `ipn.StateStore`, `sealedStore` in `helpers/tailnet/statestore.go`.
   - It keeps the whole state in `state.sealed`, sealed with AES-256-GCM under the node's 32-byte state key, with a fresh nonce on every write and the format name as additional data.
   - The file is replaced in one step, with mode 0600.
2. **The state key is kept only sealed by the system's keystore, by the app.**
   - The main process makes the key once per tailnet and seals it with Electron's `safeStorage`: the Keychain on macOS, DPAPI on Windows, and the Secret Service or KWallet on Linux.
   - It keeps the sealed key in `<userData>/tailnets/<tailnet>.key`, with mode 0600, and gives the key to the helper in `StartNode.state_key`.
   - The helper never writes the key anywhere.
3. **No keystore, no node.**
   - Without a keystore, no node starts, and the local window shows the tailnet as stopped with the reason.
   - On Linux, the backends `basic_text` and `unknown` count as no keystore, because they seal with a password built into Chromium.
   - A development build (unpackaged) still runs there, with a warning, so that headless development machines and CI keep working.
   - GEN4 ships for macOS and Windows only.
4. **The state in the clear is taken over once.**
   - A node that still has a `tailscaled.state` has it sealed at its next start, and the clear file is removed.
   - A node keeps its identity and needs no new sign-in.

## Why the app's keystore and not the helper's own

#2 first proposed that the helper itself talk to the keystore. The app's `safeStorage` gives the same protection with less to build and to trust:

- **Less code to build:**
  - no cgo for the macOS Keychain;
  - no own client for the Secret Service;
  - no size limit of Windows credentials.
- **Less to trust:** one keystore item for the whole app, whose access the signed app holds. It is not one per helper binary.
- **The same in GEN5:** it is also Electron on the same identity `io.lazurio.app` (decision 0248), so it opens the same sealed keys, and it starts the helpers unchanged.

What the helper keeps on disk is useless without the app's keystore.

## Consequences

- **What the state directory still holds in the clear:**
  - tsnet's network map cache (`profile-data/<id>/netmap-cache`), which names the tailnet's peers and their addresses but no private key;
  - `tailscaled.log.conf`, which nothing uses since log uploads are off (#9).
- **A lost or unreadable sealed key** leaves the node's sealed state unopenable, and the node does not start, so it never changes its identity unnoticed. The local window shows the reason. Removing the node's state directory lets it sign in again, after which it needs approval again.
- **The removal of `tailscaled.state` is no secure erase.** On an SSD the old bytes may stay on the medium until it overwrites them. A node whose old state may have been copied should be removed from the tailnet and signed in again.
