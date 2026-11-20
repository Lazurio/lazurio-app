# Tailnets of Lazurio App on a Mac

The Mac counterpart of [the Windows policy and setting](tailnet-policy.md), for Lazurio App (Alpha) at a client. Like on Windows, it says only where the Organization's tailnets are and grants nobody access. It ends when Lazurio App gets a person's tailnets from their Lazurio account ([ADR 0008](../adr/0008-tailnets-from-a-directory.md), point 6).

The content is the same JSON array as on Windows, as one string under the key `Tailnets` of the preference domain `io.lazurio.app`. Lazurio App takes only control servers and suffixes below `lazurio.io` or `lazurio.ai`. A text that does not decode joins no tailnet at all.

## Where Lazurio App reads it

1. **IT's policy:** a managed preference, `/Library/Managed Preferences/<account>/io.lazurio.app.plist`, else `/Library/Managed Preferences/io.lazurio.app.plist`.
   - A configuration profile or a device-management tool writes these files, and only an administrator can.
   - A policy always wins. A policy file whose `Tailnets` cannot be read as a string keeps the person's setting unread.
2. **The person's own setting:** `Tailnets` in their own defaults for `io.lazurio.app`, which `defaults write io.lazurio.app Tailnets -string '…'` sets without an administrator. Without `-string`, `defaults` would try to read the JSON as a property list and fail.
   - Lazurio App reads it only when there is no policy file.
   - Any program running with the person's rights can change it, but it can point the app only at Lazurio's own control servers.

Lazurio App reads them with `/usr/bin/plutil` and `/usr/bin/defaults`, at those fixed paths. While it runs, version 0.1.4 and later read them again every ten seconds. Once they name another network the app can join, it says so and starts again by itself. While an agent works on the computer, it waits for the agent to finish.

Its log names the source with `tailnets { source: 'policy', … }` or `tailnets { source: 'user-setting', … }`.

To check it, run `defaults read io.lazurio.app Tailnets`. To remove it, run `defaults delete io.lazurio.app Tailnets`.

## The files Lazurio sends

Lazurio fills in the Organization's values privately. The address of a customer Organization's network is never in this repository or in a published build.

### `lazurio-app-tailnets.command`: the person's own setting

The template is [`lazurio-app-tailnets.command`](lazurio-app-tailnets.command). Replace `<tailnet>`, `<control-server>` (the control server's host name) and `<domain>`.

It runs `defaults write` as the signed-in person and asks for no administrator. A double-click opens it in Terminal, which prints "Done. The network setting is saved for this Mac account." or "The network setting was not saved."

- **Send it inside a `.zip`:** a double-click runs it only with its execute permission (`chmod +x`), and a plain download loses that permission, while the Archive Utility keeps it.
- **Gatekeeper:** the file is not signed, so the first double-click of a downloaded file is blocked. The person then chooses System Settings → Privacy & Security → **Open Anyway**, and confirms with their Mac's password.

### `lazurio-app-tailnets.mobileconfig`: a profile, as IT's policy

The template is [`lazurio-app-tailnets.mobileconfig`](lazurio-app-tailnets.mobileconfig). Replace `{{tailnet}}`, `{{control-server}}` and `{{domain}}`, and give `{{profile-uuid}}` and `{{payload-uuid}}` two new UUIDs (`uuidgen`).

The profile installs a managed preference for the whole computer (`PayloadScope` `System`), so Lazurio App takes it as IT's policy. To install it, the person double-clicks it, then opens System Settings → General → Device Management (on older systems Privacy & Security → Profiles) and installs it. macOS shows it as unverified, because it is not signed, and asks for an administrator's password. Removing the profile removes the setting.

## What is proven

The macOS end-to-end test (`e2e/tailnet-policy-mac.e2e.test.ts`) runs on the CI's macOS runner:

- It runs the `.command` template with test values the way Terminal does (`/bin/sh`, as the runner's account), and reads the value back as the app does.
- It writes a managed preference file with `sudo` and reads it as the policy.
- It fills in the profile template and checks that it is a valid property list holding the same text.

**Not proven yet:** installing the profile, Gatekeeper's prompts, and a person's double-click on a real Mac.
