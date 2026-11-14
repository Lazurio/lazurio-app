# 0001 — The technological foundation of Lazurio App GEN4

- **Status:** accepted
- **Decided:** 2026-11-14 by Matěj Suchánek
- **Related:** decisions 0240, 0241 and 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md)

## Context

Lazurio App GEN4 is a native app on Electron that shows the web Lazurio and carries a built-in tailnet node and the Device's capabilities (decision 0248). Lazurio App GEN5 will replace it as an update. GEN5 is built in the fork [Lazurio/t3code](https://github.com/Lazurio/t3code), whose Lazurio layer is already written with Effect, Effect Schema, pnpm, Node and Vite+. The aim is that nothing written here ever has to migrate to another language, runtime or toolchain on its way to GEN5.

## Decision

1. **Three languages, each forced by one fact.**
   - **TypeScript** runs the Electron main process, the preload and the local windows.
   - **Go** runs the tailnet helper, because tsnet exists only in Go.
   - **Rust** runs the Device helper, because the engine `Lazurio/agent-desktop` and the core of Lazurio Agent Desktop are Rust.
   - The repository holds no JavaScript (`pnpm check:javascript`).
2. **The TypeScript toolchain is the fork's.** It uses the same versions as the fork's catalog, and one changes here only after the fork changes it:
   - pnpm 12.14.0 and Node 26.12.1;
   - Vite+ 1.4.0, which runs oxlint, oxfmt and vitest;
   - Effect 4.1.2, with Effect Schema at every boundary;
   - React 19.3;
   - Electron 44.10.1, electron-builder 26.16.1 and Playwright 1.64.1.
   - The same `tsconfig.base.json` flags and the same Effect language service diagnostics.
   - The fork's patch of `@effect/vitest`, which runs it on Vite+'s vitest.
   - The rules of the fork's oxlint plugin that are not specific to T3 Code, vendored unchanged ([tools/oxlint-plugin-t3code](../../tools/oxlint-plugin-t3code/README.md)).
3. **The helpers speak Protocol Buffers over standard input and output.** The protocol is versioned in `proto/` and framed as size-delimited messages.
   - `buf lint` runs on every PR, and `buf breaking` against `main` refuses a change that would break an older counterpart.
   - The TypeScript and Go code is generated and committed, and CI checks that it is up to date. Rust generates its code in `build.rs` with protox, so no `protoc` is needed.
   - A helper listens on nothing for this conversation.
4. **Pages hold no power.** The tests enforce this:
   - Local windows load from `lazurio-app://shell` with a strict content security policy, and they alone get the preload bridge.
   - Remote pages get no preload and their own session.
   - Every permission is refused and no page opens a window.
   - Each view's kind (the app's own files, or Lazurio's pages) is fixed when the app creates it. Every frame of the view, the main frame and each subframe alike, loads only addresses of that kind; a subframe may also be an empty frame of its page (`about:blank`, `about:srcdoc`). The guard runs on `will-frame-navigate` and `will-redirect`, which cover all frames.
   - An address with credentials is never opened, over HTTPS or HTTP.
   - Addresses outside Lazurio go to the system's browser.
   - The Electron Fuses are set by electron-builder and read back from the built app (`pnpm --filter @lazurio/app-desktop check:fuses`).
5. **Supply chain.**
   - Only exact versions are used, the lockfiles are committed and installs run with `--frozen-lockfile`.
   - Only listed packages may run install scripts (`allowBuilds`).
   - A package release younger than seven days is not installed (`minimumReleaseAge`). For Go and Rust, versions change only by deliberate update, with the same age rule checked by hand.
   - GitHub Actions are pinned to commits.
6. **Licenses.** The repository is under the Elastic License 2.0, like Lazurio Platform and Lazurio Agent Desktop. Code taken from T3 Code keeps its MIT license and notice ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)).
7. **CI.**
   - Linux runs on every pull request: format, lint, types, knip, tests, the protocol, Go, Rust and end-to-end with the operating system's sandbox, plus packaging and fuses.
   - macOS and Windows build, run end-to-end and check the fuses when a pull request changes the app, the helpers, the protocol or their tools, and before every release.

## Deviations from the fork, and why

- **Type checks run the stable TypeScript 7.0.2 (`effect-tsgo tsc@7.0.2`), not the fork's `tsrs`,** which is a TypeScript 7.1 beta. Both run the same Effect language service. This repository moves to `tsrs` when it leaves beta.
- **The lint is stricter.** Correctness and suspicious rules are errors, and `any` and non-null assertions are refused. Code that passes here also passes the fork's lint, but not the other way round. Vendored code is exempt from the stricter rules.
- **Import boundaries are enforced:**
  - the local windows import neither Electron nor Node;
  - the main process imports no React;
  - Electron's renderer IPC lives only in the preload.

## Deviations from Lazurio's stack profiles (F69), and why

F69 pins Bun, Biome, TypeScript and Zod for Modules, which Lazurio runs with its pinned Bun. It postponed Vite+ only because Vite+ runs on Node. An Electron app runs on Electron's own Node, so that reason does not apply here. Following F69 would mean rewriting every package into Effect Schema, oxlint and vitest when it moves to GEN5. F69 itself is unchanged.

## Alternatives considered

| Alternative                                   | Why not                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri, continuing Lazurio Agent Desktop       | Tauri 2.12.5 gives a web view a proxy only on macOS 14+ and without a password (wry's proxy is host and port), and several web views in one window only behind `unstable`. A proxy without a password would let any local process or user enter the tailnet as the person. GEN5 would also mean a change of runtime. |
| Lazurio's stack profile F69 (Bun, Biome, Zod) | A rewrite of every package on the way to GEN5 (above).                                                                                                                                                                                                                                                               |
| JSON-RPC with JSON Schema between processes   | Readable on the wire, but three code generators and weaker checks of backward compatibility.                                                                                                                                                                                                                         |
| MIT for the repository                        | Moving code into the MIT fork would carry no license seam, but the app's own code, including the Device's capabilities, would be free for anyone to take.                                                                                                                                                            |

## Verification (2026-11-14, Linux x64)

- **`pnpm check`** ran:
  - no JavaScript;
  - format;
  - lint (0 errors, 187 rules);
  - types in 5 packages;
  - knip;
  - `buf lint`;
  - tests: 1 framing, 6 navigation and 196 for the vendored lint rules.
- **Go:** `go vet` and `go test -race` passed. **Rust:** `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test` (3 tests) passed.
- **End-to-end (6 tests):**
  - both helpers pass their handshake;
  - the local window has the bridge and no Node;
  - a remote page has no bridge, no Node and no Electron, opens no window, gets no permission, cannot navigate away, cannot load a foreign page into a frame even directly, and hands the web to the system's browser.
  - On the developer's Linux machine these ran with Electron's isolation but without Chromium's operating system sandbox (Playwright adds `--no-sandbox` on Linux). CI turns that sandbox on.
- **Packaging:** `electron-builder --dir` for Linux put both helpers in `resources/helpers`, and `check:fuses` read all seven fuses in their safe state. The packaged app started both helpers.
- **Review found two gaps,** both closed with tests: subframes were not guarded, because `will-navigate` covers only the main frame (the new end-to-end case fails without the fix), and HTTP addresses with credentials went to the system's browser.
- **The tests found a real defect** before it shipped: the main process compared URL origins, which Node gives as `"null"` for a custom scheme, and so refused the app's own window.
- **Not yet verified:** macOS and Windows, which the first CI run covers; signing; updates.
