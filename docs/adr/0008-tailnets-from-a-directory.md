# 0008 — Which tailnets a packaged app joins, and how its node signs in

- **Status:** proposed
- **Proposed:** 2026-11-17, for the proof of concept of plan LZD-0017 (task 640)
- **Amended:** 2026-11-17, with Matěj's decisions on the source of a person's tailnets, on the IT policy for Lazurio App (Alpha) at a client and on two sign-ins in the first version (points 6 and 7, open questions 1 and 2), and the issuer of the app's own client (consequences)
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
   - A later source replaces it without touching the rest of the app: the directory of the person's Organizations at Lazurio Auth (point 6).
   - `LAZURIO_APP_DEV_TAILNETS` stays for unpackaged builds only and replaces the directory there.
   - **Whatever the source, the app takes only control servers and DNS suffixes below Lazurio's own domains** (`lazurio.io`, `lazurio.ai`), never at the domain itself (Matěj, 2026-11-17). An entry with a control server that is no plain `https://` address below them, or with a suffix outside them, is refused and logged, and the app joins the rest.
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
6. **The sources after the proof of concept** (Matěj, 2026-11-17, about 17:10Z):
   - **Target: the directory of the person's Organizations at Lazurio Auth**, asked as a request of its own after the sign-in, not carried inside the sign-in. The Dashboard is not a source. It comes with plan LZD-0017, task 644. As agreed with the refactoring of Lazurio's sign-in (AUTH REFACTOR):
     - The Auth side is a read for the signed-in person, "my Organizations and their tailnets", in plan LZD-0009.
     - The app asks with its own public client at the issuer (point 7).
     - Memberships come only from what Auth stores. Control servers and DNS suffixes come from the registration of each tailnet's client, whose source is the Organization's `infra`.
     - The directory returns tailnets, each once, with the Organizations each serves, since one tailnet can serve several Organizations. The app never derives a control server from an Organization's name.
     - The app keeps the last valid list, so a computer already joined does not need the directory when it starts.
   - **Until then, on Windows, an IT policy for Lazurio App (Alpha) at a client.** It is an exception to decision 1 of the network part, which assigns tailnets by account: the policy assigns them by computer.
     - The Organization's IT writes the string value `Tailnets` under `HKLM\SOFTWARE\Policies\Lazurio\App`, in the built-in directory's JSON, through Group Policy or its device management. Only an administrator writes there. Lazurio App itself is installed per user, though, so a program with the person's rights can change the app as well as what it reads. The policy keeps the list of tailnets an administrator's setting; it does not protect an installation the person's own programs can change.
     - The app's own tailnet helper reads it through the registry's API (`lazurio-tailnet read-policy`, the 64-bit view) when the app starts, so neither the path nor the environment chooses the program that answers.
     - Where a policy exists it replaces the built-in directory. A policy that does not decode joins no tailnet rather than the built-in one.
     - The same check of Lazurio's domains applies. The exception ends with task 644.
     - How IT deploys it: [Tailnets of Lazurio App set by IT](../it/tailnet-policy.md).

7. **Two sign-ins in the first version** (Matěj, 2026-11-17, 17:44–17:47Z):
   - **The app's own public client signs in in the system's browser**, with a redirect to the loopback (RFC 8252). It does so for the directory and for the Device's permission. The node's sign-in stays there too (point 2).
   - **One browser session:** both sign-ins share the person's session at the issuer in the browser. The app's window, with the Dashboard and the Environments, keeps its own.
   - **Twice in all:** the person signs in once in the browser and once in the window.
   - **No change to ADR 0002:** the window does not catch the redirect of the app's own client.
   - **Later:** one sign-in for both waits for a function of Lazurio Auth that hands a sign-in from the browser over to the window's session (plan LZD-0017, task 647).

## Consequences

- **The person signs in twice** with the same Lazurio account: once in the system's browser, for the tailnet node and the app's own client, and once in the app's view, for the Dashboard and the Environment. Matěj accepted this for the first version (point 7); one sign-in waits for Lazurio Auth.
- **Approving a new Device stays a step of an Owner** in the Organization's Deployment Repo (approved Devices, plan, apply). The proof of concept on a person's computer needs that step for its Device.
- **A directory built into a public repository names only Lazurio's own tailnets.** A customer Organization's control server never goes into this repository or into a published build. It reaches the app through the IT policy on the Organization's own computers, and later through the directory at Lazurio Auth.
- **The IT policy assigns tailnets by computer.** Everyone who signs in on a computer with the policy gets its tailnets offered, and only members get past Lazurio Auth's check. It is accepted for Lazurio App (Alpha) at a client and ends with task 644.
- **The directory gives only a control server and DNS suffixes**, which are no secrets: the names are public in DNS, and the control server admits only members.
- **A node's and an Environment's sign-ins never name the issuer:** a node signs in through the login address its control server gives, and an Environment through its gateway's redirects. Only the app's own client (point 7) names it, through `LAZURIO_AUTH_ISSUER`. An issuer that moves therefore changes neither the node's nor the Environment's sign-in.
- **The issuer appears in exactly two lines of `apps/desktop/src/main/Navigation.ts`:** its host `LAZURIO_AUTH_HOST`, which ADR 0002 uses, and the issuer `LAZURIO_AUTH_ISSUER` derived from it, which only the app's own client uses (point 7). ADR 0002 uses it to let a remote view show the issuer and, only during a sign-in it answered, GitHub's sign-in pages.
  - An issuer on another subdomain of `lazurio.io` stays allowed as a page of Lazurio. The constant still has to name it for the GitHub exception.
  - An issuer outside `lazurio.io` and `auth.lazurio.ai` needs that constant and an amendment of ADR 0002 and decision 0248.

## Open questions for Matěj

1. **Where a person's tailnets come from after the proof of concept.** Decided by Matěj on 2026-11-17: the directory of the person's Organizations at Lazurio Auth, as a request of its own after the sign-in, not the Dashboard (point 6).

2. **One sign-in for the app instead of two.** Decided by Matěj on 2026-11-17 for the first version: two sign-ins, with the app's own client in the system's browser and ADR 0002 unchanged (point 7). One sign-in waits for Lazurio Auth.

## Alternatives considered

| Alternative                                                      | Why not now                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A new endpoint at the sign-in issuer before the proof of concept | It needs a client and an endpoint at the issuer, both undecided, while the issuer itself is being refactored. That decision is Matěj's.                                                                      |
| The Dashboard's account API now                                  | Matěj decided against the Dashboard as a source (point 6). Its control servers never leave the server today, and the app could call it only through an Environment's gateway, which needs the tailnet first. |
| Starting a node only when a page of its tailnet is opened        | Fewer sign-ins for a person with many Organizations. For one tailnet in the proof of concept it adds nothing, so it comes with a directory per account.                                                      |
