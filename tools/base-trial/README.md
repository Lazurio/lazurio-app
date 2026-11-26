# Base trial (lazurio-app#97)

Trial only, not part of the app: evidence for the choice between stock Electron, an own build of
Electron and a base on Chromium, on the two hardest items, passkey sign-in and the vault's password
manager.

- `webauthn-probe`: what stock Electron 44.10.1 offers a page for passkeys on a computer. It runs
  against the public demo relying party `webauthn.io` and completes no credential by itself.
  - macOS: `open -W -n Electron.app --args <probe> --out=<file> [--mode=touchid]`.
  - Windows: `run-windows.ps1 -Ref <commit>`, in the signed-in person's session.
- `vault`: Bitwarden's own Chromium build 2026.10.2 in Electron 44.10.1 with
  `electron-chrome-extensions` 4.10.0, against Vaultwarden 1.37.5 with a real account.
  - `seed.ts` makes the account and one login item the way a Bitwarden client does (PBKDF2 master
    key, HKDF-stretched keys, AES-256-CBC with HMAC, an RSA key pair).
  - `main.ts` points the extension at the server, signs in with the master password in its popup
    and fills the sign-in form of a page in a tab; `steps-fill.json` is the run.
  - It needs Chromium's OS sandbox (issue #8): `Dockerfile` gives Electron its setuid sandbox in a
    container, and `run.sh` starts it with `--cap-add SYS_ADMIN` for that container only.
  - Vaultwarden runs on loopback with TLS (Bitwarden refuses a server URL without HTTPS); the
    trial session trusts that certificate on loopback only.
