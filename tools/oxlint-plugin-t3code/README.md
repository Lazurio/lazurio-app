# oxlint-plugin-t3code (vendored subset)

The rules of T3 Code's oxlint plugin that are not specific to T3 Code's product. They are copied unchanged from [Lazurio/t3code](https://github.com/Lazurio/t3code/tree/3ffe8f47d2d2/oxlint-plugin-t3code) at commit `3ffe8f47d2d2`, so that code written in Lazurio App GEN4 already passes the rules it meets in GEN5, which is built on that fork.

- **License:** MIT, Copyright (c) 2026 T3 Tools Inc., kept in [LICENSE](LICENSE). The rest of this repository is under the Elastic License 2.0.
- **Edits:** only `index.ts` is our own, and it lists the subset. A rule is never edited here. A change goes to the fork first and is copied back.
- **Sync:** when the fork changes one of these rules, copy the rule and its test from the same fork commit as the rest, and update the commit above.
- **Left out** because they concern T3 Code's own product: the mobile, settings, pull request and MCP registration rules, and the React rules for components this app does not have yet.
