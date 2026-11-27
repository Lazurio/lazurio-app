# Signing Lazurio App

Lazurio App is signed by Lazurio's own identities: on macOS with a Developer ID Application certificate, with notarization, and on Windows with Microsoft's Artifact Signing. Until an identity is in place, `release.yml` builds exactly as before: Windows unsigned and the Mac ad hoc ([ADR 0005](adr/0005-installers-updates-and-channels.md), point 7). Nothing secret goes into this repository, a log or a chat.

## Where the identities live

They live in the GitHub Environment **`lazurio-app-signing`** of `Lazurio/lazurio-app`. Only the `build` job of `release.yml` uses it.

**Deployment refs:** set the Environment to `main` and the tags `v*`, so that no pull request and no other branch can read it.

**Which channels sign** is set by the repository variable `LAZURIO_APP_SIGNED_CHANNELS`. A build of a channel not in it takes the Environment `lazurio-app-unsigned`, which holds no identity, and builds as before.

- **`nightly stable`** (the default, also when the variable is unset): every nightly is signed. Whatever review lets into `main` comes out signed. `lazurio-app-signing` has no required reviewer, and Publication stays at the gate `lazurio-app-stable`.
- **`stable`:** only a stable build signs. Stable builds run from a nightly's tag. Give `lazurio-app-signing` a required reviewer, so that no build reaches the identities before someone approves it.

**Create the Environment with these rules before adding a secret.** A workflow run creates it by itself, but without any rules.

| Name                      | Kind     | What it is                                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `CSC_LINK`                | secret   | the Developer ID Application certificate with its private key, a `.p12` in base64     |
| `CSC_KEY_PASSWORD`        | secret   | the `.p12`'s password                                                                 |
| `APPLE_API_KEY_P8`        | secret   | the App Store Connect API key for notarization, the `.p8` file's text                 |
| `APPLE_API_KEY_ID`        | secret   | that key's ID                                                                         |
| `APPLE_API_ISSUER`        | secret   | the issuer ID of the App Store Connect team                                           |
| `APPLE_TEAM_ID`           | variable | the Apple team, 10 characters; not secret                                             |
| `AZURE_TENANT_ID`         | variable | the Entra tenant of Artifact Signing                                                  |
| `AZURE_CLIENT_ID`         | variable | the app registration that GitHub's OIDC token signs in as; it has no secret           |
| `AZURE_SIGNING_ENDPOINT`  | variable | the account's endpoint, for example `https://weu.codesigning.azure.net`               |
| `AZURE_SIGNING_ACCOUNT`   | variable | the Artifact Signing account's name                                                   |
| `AZURE_SIGNING_PROFILE`   | variable | the certificate profile (Public Trust)                                                |
| `AZURE_SIGNING_PUBLISHER` | variable | the publisher exactly as in the certificate's subject; updates are checked against it |

- **A Mac build signs** only when `CSC_LINK` and `APPLE_API_KEY_P8` both exist.
  - The build then has hardened runtime and is notarized, and the ticket is stapled.
  - It carries `macSelfUpdate=true`, so that it updates itself through Squirrel.Mac.
  - The notary key exists as a file only on the runner, during the Package step.
- **A Windows build signs** only when `AZURE_SIGNING_ENDPOINT` exists. It signs in to Azure with GitHub's OIDC token (`azure/login`) and holds no client secret.
- **The Signature step proves a signed build:**
  - on a Mac, `codesign --verify --deep --strict`, `spctl --assess` and `xcrun stapler validate`;
  - on Windows, `Get-AuthenticodeSignature` on the installer.

## What the Apple account holder does

The account holder supplies these, in order:

1. **Accept the license and pay.** Only the account holder can. The membership then becomes active.
2. **Read the Team ID** in Membership details and put it in `APPLE_TEAM_ID`.
3. **Create the certificate on their own Mac.**
   - In Keychain Access, use Certificate Assistant → Request a Certificate…, saved to disk. The private key is made there and stays in their Keychain.
   - Upload the request at developer.apple.com → Certificates → Developer ID Application (G2).
   - Download the certificate and open it, so that it joins the key in the Keychain.
   - Export both as a `.p12` with a strong password.
   - Put the `.p12` in base64 in `CSC_LINK` and the password in `CSC_KEY_PASSWORD`.
4. **Create a team API key for notarization** in App Store Connect → Users and Access → Integrations → Team Keys, with the role Developer. Its `.p8` can be downloaded only once. Put its text in `APPLE_API_KEY_P8`, and the Key ID and the Issuer ID in the two secrets for them.
5. **Back up** the `.p12` with its password and the `.p8` in the Organization's vault, and keep a second copy offline.
   - A lost key means a new certificate.
   - Revoke the certificate only after a leak: a revoked Developer ID can stop releases already out from opening.

## Windows: Artifact Signing

These steps follow Microsoft's validation of the Organization's identity:

1. **Create a certificate profile** (Public Trust) in the Artifact Signing account.
2. **Register an app in Entra.**
   - Give it a federated credential for GitHub: repository `Lazurio/lazurio-app`, Environment `lazurio-app-signing`.
   - Give it the role Certificate Profile Signer on the profile.
3. **Fill in the six `AZURE_*` variables.**

The first signed Windows build installs over an unsigned one. From then on the app refuses an update that is not signed by `AZURE_SIGNING_PUBLISHER`. Fill in the variables only with a verified certificate.
