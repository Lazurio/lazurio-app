# Third-party notices

Lazurio App is under the [Elastic License 2.0](LICENSE). These parts come from other projects and keep their licenses.

## T3 Code

From [Lazurio/t3code](https://github.com/Lazurio/t3code) at commit `3ffe8f47d2d2`, the fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). MIT License, Copyright (c) 2026 T3 Tools Inc.

- `tools/oxlint-plugin-t3code/rules/*`, `utils.ts` and `test/utils.ts`: copied unchanged. The license is in [tools/oxlint-plugin-t3code/LICENSE](tools/oxlint-plugin-t3code/LICENSE).
- `tsconfig.effect.json`: copied unchanged.
- `patches/@effect__vitest@4.1.2.patch`: copied unchanged.
- `tsconfig.base.json`, the lint and test settings in `vite.config.ts`, and the structure of `apps/desktop/src/main/LocalScheme.ts`: adapted.
- The shape of `apps/desktop/src/main/ElectronUpdater.ts` and the channel rules of `apps/desktop/src/main/Updates.ts` and `UpdateChannel.ts`, after `apps/desktop/src/electron/ElectronUpdater.ts` and `apps/desktop/src/updates/` at commit `cab18ad99b`: adapted.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
