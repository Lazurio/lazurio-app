# 0008 — Which tailnets a packaged app joins, and how its node signs in

- **Status:** proposed
- **Proposed:** 2026-11-17, for the proof of concept of plan LZD-0017 (task 640)
- **Related:** decision 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md), [ADR 0002](0002-sign-in-pages.md) (pages of a remote view), [ADR 0003](0003-node-state-sealed.md) (sealed node state), [ADR 0005](0005-installers-updates-and-channels.md) (updates)

## Context

Matěj decided on 2026-11-17 that the first Lazurio App may ship without the Device's capabilities. It must be a browser with a built-in tailnet in which the web Lazurio runs, where a person signs in with their Lazurio account. A proof of concept is wanted this week, rough, but on the right foundations.

Today a packaged app joins no tailnet and shows no remote page. Tailnets come only from `LAZURIO_APP_DEV_TAILNETS`, which a packaged app never reads (ADR 0001).

What exists:

- **The tailnet helper** runs one tsnet node per tailnet and reports `needs-login` with a login address on the tailnet's control server. The app opens that address in the system's browser, and only on that host (`isSafeLoginUrl`).
- **A tailnet's Headscale signs nodes in with OIDC at Lazurio Auth** (`https://auth.lazurio.ai/realms/workspace`). Lazurio Auth lets a person register only after it checks that they are a member of an Organization the tailnet serves (its `tailnet:<organization>` group). The node lands under the person's own Headscale user. An Owner then approves the Device by a reviewed revision of the Organization's approved Devices (`approved_devices`). On 2026-11-14 node 744 went this way in Lazurio Example.
- **Lazurio Auth has no client** a desktop app could sign in with (no public client, no device grant, no loopback or `lazurio://` redirect). It also has no endpoint that lists a person's tailnets.
- **The Dashboard** (`https://dashboard.lazurio.ai`, a page of Lazurio in a remote view per ADR 0002) signs a person in with their Lazurio account and links their Environments. It keeps each Organization's control server on the server only.

## Decision

1. **A tailnet directory, behind one interface.**
   - The main process reads the tailnets it may join from a `TailnetDirectory`: each tailnet's name, control server and DNS suffixes, decoded through Schema.
   - The proof of concept's directory is built into the app (`apps/desktop/tailnets/directory.json`) and lists the tailnet of Lazurio Example, Lazurio's own demo Organization.
   - A later source replaces it without touching the rest of the app: a list per account from the Dashboard or from Lazurio Auth. Which one is open question 1.
   - `LAZURIO_APP_DEV_TAILNETS` stays for unpackaged builds only and replaces the directory there.
2. **Access is the account's, decided by the tailnet, not by the directory.**
   - A packaged app starts a node for each tailnet in its directory.
   - A node that needs a sign-in opens its control server's login page in the system's browser. The person signs in there with their Lazurio account, and only a member of the Organization gets in.
   - The Device then waits for an Owner's approval by the Organization's rules, and the window shows that.
   - Being listed in the directory grants nothing. A person who is not a member never gets past Lazurio Auth's check.
3. **The node's name** is `lazurio-app-<computer>`: the operating system's host name, lower case, letters, digits and hyphens. An empty name becomes `lazurio-app-device`. An Owner thus sees a readable name when approving the Device. The node keeps its identity in its sealed state (ADR 0003) whatever the name later becomes.
4. **The first page of a packaged app is the Dashboard** (`https://dashboard.lazurio.ai/`).
   - The person signs in there with their Lazurio account and opens their Environment's Launchpad.
   - The Launchpad loads in the same view through the tailnet's node: the proxy's PAC script sends the tailnet's names to it, and the first page waits for its tailnet as today.
   - The Environment's own sign-in goes through its gateway, Lazurio Auth and GitHub, unchanged (ADR 0002).
5. **Updates are unchanged** (ADR 0005). The proof of concept is a nightly or trial build of the same app.

## Consequences

- **The person signs in twice** with the same Lazurio account: once in the system's browser for the tailnet node, and once in the app's view for the Dashboard and the Environment. Folding the node's sign-in into one app sign-in needs a client at Lazurio Auth (open question 2).
- **Approving a new Device stays a step of an Owner** in the Organization's Deployment Repo (approved Devices, plan, apply). The proof of concept on a person's computer needs that step for its Device.
- **A directory built into a public repository names only Lazurio's own tailnets.** A customer Organization's control server never goes into this repository. A directory per account replaces the built-in one before any customer's tailnet is listed.
- **The directory gives only a control server and DNS suffixes**, which are no secrets: the names are public in DNS, and the control server admits only members.
- **The app never names the sign-in issuer for its own sign-ins.** A node signs in through the login address its control server gives, and an Environment through its gateway's redirects. An issuer that moves therefore changes neither the node's nor the Environment's sign-in.
- **The issuer's host appears in exactly one place:** `LAZURIO_AUTH_HOST` in `apps/desktop/src/main/Navigation.ts`. ADR 0002 uses it to let a remote view show the issuer and, only during a sign-in it answered, GitHub's sign-in pages.
  - An issuer on another subdomain of `lazurio.io` stays allowed as a page of Lazurio. The constant still has to name it for the GitHub exception.
  - An issuer outside `lazurio.io` and `auth.lazurio.ai` needs that constant and an amendment of ADR 0002 and decision 0248.

## Open questions for Matěj

1. **Where a person's tailnets come from after the proof of concept.** Two candidates:
   - the Dashboard's account API, which already knows the person's Environments and each Organization's control server but keeps the latter on the server;
   - the sign-in issuer, which the refactoring of Lazurio's sign-in now under way (plan in shaping) may shape anew.

   This proof of concept assumes neither and changes nothing at the issuer.

2. **One sign-in for the app instead of two.** It would need a client of Lazurio App at the issuer, and possibly claims about the person's Organizations or tailnets in its token. That belongs to the refactoring of the sign-in, not to this proof of concept.

## Alternatives considered

| Alternative                                                      | Why not now                                                                                                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new endpoint at the sign-in issuer before the proof of concept | It needs a client and an endpoint at the issuer, both undecided, while the issuer itself is being refactored. That decision is Matěj's.                                             |
| The Dashboard's account API now                                  | Its control servers never leave the server today, and changing that is a decision. The app could also call it only through an Environment's gateway, which needs the tailnet first. |
| Starting a node only when a page of its tailnet is opened        | Fewer sign-ins for a person with many Organizations. For one tailnet in the proof of concept it adds nothing, so it comes with a directory per account.                             |
