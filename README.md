# Lazurio App

The native app for Lazurio on macOS and Windows. It shows the web Lazurio of a person's Environments, reaches them through its own built-in tailnet node without Tailscale installed, and carries the Device's capabilities, so that the agents of an Environment may use the computer's apps while its owner allows it.

This is **Lazurio App GEN4** (decision 0248 in the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md)). The native app on T3 Code, GEN5, will replace it as an update. The first version is in preparation.

- **Foundation:** TypeScript with Effect on Electron, a tailnet helper in Go and a Device helper in Rust, speaking Protocol Buffers ([docs/adr/0001](docs/adr/0001-technological-foundation.md)).
- **Working on it:** [AGENTS.md](AGENTS.md) has the layout, the commands and the rules.

Licensed under the [Elastic License 2.0](LICENSE). Parts taken from T3 Code keep their MIT license ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
