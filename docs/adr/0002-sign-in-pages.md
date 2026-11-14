# 0002 — Which pages a remote view shows: Lazurio, its sign-in, and nothing else

- **Status:** accepted
- **Decided:** 2026-11-14 by Matěj Suchánek, after the first sign-in through the app's tailnet node ([#4](https://github.com/Lazurio/lazurio-app/issues/4))
- **Related:** decision 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md), [ADR 0001](0001-technological-foundation.md)

## Context

A remote view shows the web Lazurio and nothing else, and every other address goes to the system's browser (decision 0248). Until now, the web Lazurio meant `lazurio.io` and its subdomains. The first Environment reached through the app's tailnet node showed that this is not enough:

- the Environment sends a person who is not signed in to Lazurio Auth on `auth.lazurio.ai`;
- Lazurio Auth signs in with GitHub;
- when GitHub does not know the person yet, it shows its own sign-in pages on `github.com`.

The Environment's session cookie must end up in the remote view's own session, so this sign-in cannot move to the system's browser. The Dashboard (`dashboard.lazurio.ai`), the Organization's overview, is a page of Lazurio as well.

Launchpad connects Integrations that are not on its list yet through Composio's dashboard (`dashboard.composio.dev`). The connection itself goes on to the provider of each app (Google, Microsoft, Slack and others).

## Decision

1. **Lazurio's pages:** `lazurio.io` with its subdomains, plus exactly `auth.lazurio.ai` and `dashboard.lazurio.ai`, all over HTTPS without credentials. No other name on `lazurio.ai` is one, and neither are look-alikes.
2. **GitHub's sign-in pages, only inside a sign-in.**
   - A sign-in exists only where Lazurio Auth (`auth.lazurio.ai`, default port) actually answered. That covers two cases: a main-frame navigation that Auth's server redirected, and a page that such a navigation showed.
   - A navigation to Lazurio Auth that is refused, cancelled, replaced, answered without a page (a 204) or ends on an error page starts nothing.
   - The sign-in ends when the main frame shows any other page.
   - During it, and only in the main frame, the view may also show `https://github.com` at `/login`, `/login/…`, `/session` and `/sessions/…`: the form, its POST, two-factor, passkeys, device checks and the OAuth authorization.
   - Every other GitHub page goes to the system's browser, as before, and so does every window that a GitHub page opens.
   - Once a sign-in ends, the view forgets its history, so no page of the sign-in comes back through `history.back()`.
3. **Composio and other services stay in the system's browser.** That covers connecting an Integration and the sign-in pages of its provider.
   - The person is already signed in to these services there.
   - Providers such as Google refuse sign-ins in embedded browsers.
   - The connection is kept at the service, not in the app's session, so the Launchpad shows it once the person returns.

## Consequences

- Navigation's rules (`apps/desktop/src/main/Navigation.ts`) stay pure and carry the whole sign-in as a unit test, with every look-alike case.
- The guard (`Hardening.ts`) keeps two facts per view, both in Navigation's pure `step`:
  - the page its main frame shows;
  - the navigation under way, from its start through its redirects.
- Electron 44 reports nothing when a navigation ends without a page (`DidFinishNavigation` returns early for one that did not commit), so a navigation's state lives only until the next navigation starts. Every navigation starts with `did-start-navigation`, which Electron reports before `will-frame-navigate`.
- An end-to-end test runs the sign-in in Electron against a local HTTPS server that plays the Environment, Lazurio Auth and GitHub. It includes the failed and the cancelled navigation to Auth.
- Still open, and not part of this decision:
  - GitHub passkeys in Electron, which plan LZD-0017 verifies;
  - showing the person which site they are signing in to, since the window has no address bar (the window's prototype);
  - a way to reload a page after returning from the system's browser.
