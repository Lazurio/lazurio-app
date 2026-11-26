# Base trial (lazurio-app#97)

Trial only, not part of the app: evidence for the choice between stock Electron, an own build of
Electron and a base on Chromium, on the two hardest items, passkey sign-in and the vault's password
manager.

- `webauthn-probe`: what stock Electron 44.10.1 offers a page for passkeys on a computer. It runs
  against the public demo relying party `webauthn.io` and completes no credential by itself.
  - macOS: `open -W -n Electron.app --args <probe> --out=<file> [--mode=touchid]`.
  - Windows: `run-windows.ps1 -Ref <commit>`, in the signed-in person's session.
