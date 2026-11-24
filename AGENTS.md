# Lazurio App

Lazurio App GEN4: a native app on Electron for macOS and Windows that shows the web Lazurio of a person's Environments. It carries a built-in tailnet node and the Device's capabilities (decision 0248). Lazurio App GEN5, the native app on T3 Code, will replace it as an update, so every choice here keeps that path open. Read [docs/adr/0001](docs/adr/0001-technological-foundation.md) before changing tools, versions or boundaries, and [docs/adr/0002](docs/adr/0002-sign-in-pages.md) before changing which pages a remote view shows.

## Layout

- `apps/desktop`: the Electron app.
  - `src/main` is the main process, in Effect.
  - `src/preload` is the bridge for the app's local windows only.
  - `src/ui` is the local windows, in React.
  - `src/shared` is the bridge contract.
  - `e2e` holds the end-to-end tests.
- `helpers/tailnet`: the tailnet helper in Go: one tsnet node per tailnet and a loopback proxy with a password per start, which sends only a tailnet's own names to its node (`proto/lazurio/app/tailnet/v1`). tsnet is pinned to a commit of tailscale's `main` with the tailnet DNS fix (`96467f7d1642`), because no release has it yet.
- `helpers/device`: the Device helper in Rust. Its engine `Lazurio/agent-desktop` comes only from the fork release that `helpers/device/engine.lock` pins; `pnpm build:helpers` downloads and verifies it, and `node scripts/pin-engine.ts` pins a new release (docs/adr/0006, point 1).
  - The helper always starts the engine as `agent-desktop mcp --headed`: a switch that is on means full control of the computer, with the real mouse and keyboard. After the tree of an engine ended in the middle of a tool call of the Environment that holds the computer is gone, the helper releases the left mouse button inside the device lock (docs/adr/0006, Full control of the computer).
- `proto`: the protocol between the main process and the helpers. Its generated code lives in `packages/contracts/src/gen` and `helpers/tailnet/gen`.
- `packages/contracts`: the generated protocol code and its framing.
- `packages/shared`: shared Effect references (`HostProcess`).
- `scripts`: repository tasks in TypeScript with Effect.
- `tools/oxlint-plugin-t3code`: the fork's lint rules, vendored unchanged.

## Commands

Node 26.12.1, pnpm 12.14.0, Go 1.27.4 and Rust 1.99.1 (`helpers/device/rust-toolchain.toml`).

- `pnpm install --frozen-lockfile`
- `pnpm check` runs:
  - the JavaScript check;
  - format;
  - lint;
  - types;
  - knip;
  - `buf lint`;
  - unit tests.
- `pnpm proto:generate` after any change in `proto/`; commit the generated code.
- `pnpm build:helpers` (add `--release` for packaging).
- `pnpm --filter @lazurio/app-desktop ensure:electron`, then `build`, then `test:e2e`. On Linux, run `test:e2e` under `xvfb-run -a`.
  - Each launch of the app in a test keeps its data in a directory of its own (`e2e/user-data.ts`, `LAZURIO_APP_E2E_USER_DATA`). Launches that share a profile race for its files.
- `pnpm --filter @lazurio/app-desktop start` runs the app unpackaged. Only an unpackaged app reads these settings, and a packaged one never does:
  - `LAZURIO_APP_DEV_TAILNETS`: a JSON array of tailnets to join;
  - `LAZURIO_APP_DEV_REMOTE_URL`: an `https://` address of Lazurio for the main window, for example `https://dashboard.lazurio.ai/sign-in` to try a sign-in by hand.
- Go, in `helpers/tailnet`: `go vet ./...`, `go test -race ./...` and `golangci-lint run`.
- Rust, in `helpers/device`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`.

## Rules

- **TypeScript only, strict.**
  - No `any`, no `!` and no JavaScript files.
  - Effect for effects, errors and services, in the style of the fork's `apps/desktop`: `Effect.fn`, `Schema.TaggedError`, `Context.Reference`, and Node services instead of `node:*` imports.
  - A `node:*` import needs `// @effect-diagnostics-next-line nodeBuiltinImport:off - <reason>`.
- **Every value from outside goes through Schema.** That covers messages from a window, network responses and files on disk.
- **Pages hold no power.**
  - Only the app's local windows get the preload.
  - A remote page, and above all a module's application, never gets IPC, a key or a tailnet node.
  - Switching a Device capability on happens only in a native window.
  - A change that weakens a boundary needs a decision first, and the end-to-end tests must keep refusing it.
- **The helper protocol never breaks.**
  - Add fields and messages and never renumber.
  - `buf breaking` against `main` must pass.
  - A helper listens on nothing.
- **Versions follow the fork.** Bump a catalog version only after Lazurio/t3code bumps it, never to a release younger than seven days. The same age rule applies to Go modules and crates.
- **Tests first.** Before a change of behavior, a test fails for the right reason.
  - Flaky tests are fixed, not retried.
  - Tests wait for events, never for time.
- **Texts for people** live in the catalog of `src/ui/messages.ts`, in Czech and English. Use Lazurio's vocabulary: Prostředí/Environment, Organizace/Organization, Lazurio účet/Lazurio account.

## Ways to hurt yourself

1. **Killing by pattern.** Never `pkill`, `killall` or `kill` a process found by its name. Other apps and agents run on the same machine, so stop a process by the PID you started.
2. **Secrets in the repository.** Signing identities, the update key, keys of Devices and tailnet nodes never enter Git, logs, tests or pull requests.
3. **Weakening the app to make a test pass.** Never disable `sandbox`, `contextIsolation` or a fuse, and never widen the navigation allowlist or add a preload to a remote view, to get a test green. Fix the test or bring the change to a decision.

## Pull requests

- Work in a worktree on a branch and open a Draft pull request early.
- Make it Ready once CI is green.
- Every review is on the exact head. Merging waits for the user's go-ahead.
- Sign every text on GitHub with the line the Lazurio Folder gives your Environment (`Agent: environment <UUID> · T3 thread <UUID>`).
- Never name a customer Organization in this public repository.
