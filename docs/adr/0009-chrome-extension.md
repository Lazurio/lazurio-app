# ADR 0009: Lazurio extension for Chrome, on top of Lazurio App (proposal)

Status: proposed on 2026-11-26, for Matěj's decision. No code yet.

## Context

On 2026-11-25 Matěj set the direction (Lazurio/lazurio-app#97): people who want Lazurio in their own browser install a Lazurio extension for Chrome. Together with Lazurio App installed on the computer, the extension brings the Lazurio pages that live behind the Organization's network into the browser. It also lets an agent work in that browser through Chrome's debugging interface, so the agent can help people in their tabs. Lazurio App keeps the network (the tailnet helper) and Agent Desktop. The extension plugs into the app, and the same extension should run in the built-in browser of the ChatGPT desktop app, so a person can have ChatGPT on the left and Lazurio's apps on the right.

The pilot Organization asked for this so it can work in ChatGPT and in its own browser, with Lazurio App only in the background.

What the app already has:

- **The tailnet helper** (`helpers/tailnet`): one node per tailnet and a loopback HTTP proxy with a password per start. The proxy sends only a tailnet's own names to its node, and refuses everything else.
- **Agent Desktop** (ADR 0006): the switch per Environment, the device lock, Stop, and the channel to the Environment through which agents get tools.

## Decision (proposed)

### 1. The extension talks to the app through Chrome's native messaging

```
Chrome / ChatGPT browser                 the person's computer
┌────────────────────┐   stdio (JSON)   ┌──────────────────────┐   local socket    ┌──────────────┐
│ Lazurio extension  │ ───────────────▶ │ lazurio-bridge       │ ────────────────▶ │ Lazurio App  │
│ (service worker)   │ ◀─────────────── │ (native host, ours)  │ ◀──────────────── │ (main proc.) │
└────────────────────┘                  └──────────────────────┘  0600, per user   └──────────────┘
```

- Chrome starts the native host `lazurio-bridge`, a small binary in `resources/helpers`, only for an extension whose ID the host's manifest lists (`allowed_origins`). The app installs that manifest at its start:
  - Mac: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.lazurio.bridge.json`, and the same for the other Chromium browsers it supports;
  - Windows: a key under `HKCU\Software\Google\Chrome\NativeMessagingHosts`.
- The bridge connects to the running app over a socket only the person can open: a Unix socket in the app's data folder with mode 0600 on a Mac, a named pipe with the person's ACL on Windows.
  - It passes messages both ways.
  - When the app does not run, the bridge says so, and the extension shows "Lazurio App neběží" with a button that opens it (through a link scheme the app would register with the system for this; it has none today, and its internal `lazurio-app:` scheme serves only its own windows).
- **Why not a local port:** any process or web page can reach a port on `127.0.0.1`. Native messaging is reachable only from our extension's ID, which Chrome checks, and the socket only from the person's own processes. A process that runs as the person can do anything the person can anyway, so that is the boundary, as for the app itself.
- **How each side knows the other:**
  - The extension trusts the host Chrome starts for `io.lazurio.bridge`.
  - The bridge checks that Chrome named our extension ID as the caller (the origin argument).
  - The app accepts only the socket's own user, and gives the bridge a random token for that run.

### 2. Lazurio's pages behind the network go through the app's proxy, for Lazurio's names only

```
tab https://launchpad.<env>.<org>.lazurio.io
   │  Chrome asks the PAC script set by the extension (chrome.proxy)
   ▼
PAC: a name of the Organization's tailnet?  ── yes ──▶ PROXY 127.0.0.1:<port of the tailnet helper>
   │                                                      │ CONNECT, password per start
   no                                                     ▼
   ▼                                              tailnet node ──▶ the Environment's gateway
DIRECT (every other site, untouched)                       (TLS from the tab to the gateway, end to end)
```

- The app tells the extension, over the bridge, the proxy's port, its password for this run, and the tailnet's names. These are the same names the app's own window sends to the proxy.
- The extension sets a PAC script with `chrome.proxy`. Only those names go to the proxy, and every other site goes direct, as before. The proxy's password goes in through `chrome.webRequest.onAuthRequired` (MV3: the permissions `webRequest` and `webRequestAuthProvider`) and never appears in a page.
- **Certificates:** the tab's TLS runs inside the proxy's `CONNECT` tunnel, end to end to the Environment's gateway, with its public certificate. Nothing is installed in the system's trust store.
- **Sign-in:** the person signs in to Lazurio in their Chrome as on a computer with the network. The gateway's cookies live in Chrome's profile, apart from the app's window.
- **When the app does not run, it fails closed:** the PAC script keeps sending Lazurio's names to the proxy, so they fail and never go to the public internet. The extension says that Lazurio App is not running and offers to open it.
- **Another extension that sets a proxy,** such as a corporate VPN extension, takes `chrome.proxy` from us. Chrome lets one extension control it. The extension shows that, and the person or the Admin decides.

### 3. An agent works in a tab the person hands over, through `chrome.debugger`

```
Agent in the Environment ──tools──▶ Agent Desktop channel ──▶ Lazurio App ──bridge──▶ extension
                                                                                       │
                                     chrome.debugger.attach(tab handed over) ◀─────────┘
                                     Chrome: yellow bar "Lazurio started debugging this browser"
```

- **Tools:** a second set of tools on the same channel as Agent Desktop, `browser_*` (look at the page, click, type, navigate). The app routes them to the extension, and the extension runs them through the Chrome DevTools Protocol in that tab only.
- **The same switch:** browser tools work only while that Environment's Agent Desktop switch is on, and they share the device lock. Stop in the app's bar, in the notification area and in the extension's own button detaches the debugger at once (`chrome.debugger.detach`) and ends the agent's session, as Stop does for the desktop (ADR 0006).
- **What the person sees:**
  - Chrome's yellow bar, which an extension cannot hide; its Cancel detaches as well;
  - the extension's badge on the handed-over tab;
  - a small panel on that page with the Environment's name and Stop;
  - the app's bar, as for the desktop.
- **Why `chrome.debugger` and not content scripts alone:** content scripts cannot produce real input events, see cross-origin frames or take screenshots of the page as the agent needs. Their events are also marked as synthetic, and many sites ignore them. Content scripts stay for the panel on the page.
- **Permissions the extension asks for:** `nativeMessaging`, `proxy`, `webRequest`, `webRequestAuthProvider`, `debugger`, `tabs`, `storage`, `scripting`.
  - Host permissions: Lazurio's names for the panel; for the debugger, only at the moment of a handover (`activeTab`).
  - No permanent access to all sites.

### 4. The security boundary: only what the person hands over

The risk is an agent in the person's other tabs: the bank, mail, or another Organization's Lazurio.

- **Default: nothing.** The agent sees no tab and no list of tabs until the person hands one over. They do it from the extension's button ("Předat tuto záložku agentovi z Prostředí X") or from a link the agent sends that opens a new tab, which the person confirms.
- **A handed-over tab stays handed over only while it shows the same site.** Navigating to another site needs a new confirmation, except for the Organization's own Lazurio names. Closing the tab ends the handover.
- **Never silently everything.** No mode attaches to every tab, and the agent never gets the list of tabs, cookies or history.
- **Blocked always:** the browser's own pages, the Chrome Web Store, other extensions' pages, and sites the Admin blocks (Chrome's `runtime_blocked_hosts` policy, which also stops `chrome.debugger.attach`).
- **What the Organization's Admin sees and can do (proposal):**
  - in the Organization's overview, per computer: whether the extension is installed, which Environment has browser access and when an agent last worked in a tab, by site name only, never page content;
  - deploy and pin the extension, and block hosts, through Chrome's enterprise policies (`ExtensionInstallForcelist`, `ExtensionSettings`), as for any extension.
- **The Chrome Web Store:** `debugger` is allowed in the store, but it is treated as a high-risk permission. The listing has to justify it and expects closer review, and the install shows a warning about access to the page debugger backend. This comes from public reports of published extensions; Google's own wording on this was not found and must be read before submitting. Until it is listed, the extension can be distributed to the pilot through the Admin's policy, or as an unlisted item **(estimate)**.

### 5. The built-in browser of the ChatGPT desktop app

- **What is known:** OpenAI's help says the built-in browser on macOS and Windows supports extensions and keeps its own browser state, apart from the Chrome profile. OpenAI announced Chrome extensions in it, with central deployment by enterprise admins, in September 2025.
- **What is not known:** whether that browser supports native messaging, `chrome.proxy` and `chrome.debugger` for an extension, and where it looks for native hosts. A user also reports that an extension with a side panel did not show its panel. None of it is documented.
- **The trial before we rely on it** (one evening, on a Mac with ChatGPT Desktop):
  1. Load a minimal unpacked extension with `nativeMessaging`, `proxy` and `debugger` in the built-in browser.
  2. Native messaging: install a test host manifest in the Chrome folder, then in a folder of the ChatGPT app if one exists, and call it.
  3. Set a PAC script that sends one test name to a local proxy, and see whether the built-in browser follows it.
  4. Attach `chrome.debugger` to a tab and send `Runtime.evaluate`.
  5. Write down what each step does and the browser's version string.
- If any of this fails there, the fallback for the ChatGPT setup is a Lazurio page opened from ChatGPT's link through Lazurio's public address, without the tailnet. That is a different design, decided after the trial.

### 6. The first small version, and the second

- **Version 1, "Lazurio in my Chrome":** the bridge, the proxy for Lazurio's names, the extension's button with the state (app running, network connected, which Organization) and "Otevřít Lazurio". The person gets their Organization's Lazurio pages in their own Chrome, and in the ChatGPT browser if the trial passes, without installing Tailscale. No agent control, no `debugger` permission, so the Web Store review is simpler.
- **Version 2, "Agent in my tab":** the handover, `browser_*` tools on the Agent Desktop channel, the yellow bar and the panel with Stop, and the Admin's overview. It goes out only after its own security review and a decision on the listing.

## Consequences

- Lazurio App becomes the background service for the browser too, and its window stays Lazurio's own window.
- A new native helper (`lazurio-bridge`) and a new extension repository, with their own builds, signing and releases.
- The proxy's password per start leaves the app's process for the first time, to the extension over the person's own socket. It changes with every start of the app.
- Browser tools share Agent Desktop's switch, lock and Stop, so a person has one place to allow and stop an agent.

## Alternatives considered

| Alternative                                           | Why not                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A local HTTP port of the app for the extension        | Any web page and any local process can reach it, so it would need its own authentication. Native messaging gets the extension ID checked by Chrome. |
| Tailscale on the computer instead of the app's proxy  | One more install and sign-in for the person, and it routes the whole Organization network, not only Lazurio's names.                                |
| Content scripts only for the agent                    | No real input, no cross-origin frames, no page screenshots. Many sites ignore synthetic events.                                                     |
| Agent access to every tab, with a list to choose from | It would expose the person's other sites and Organizations by default, which is exactly the risk to avoid.                                          |
| Our own browser (Chromium fork)                       | See #97: a permanent team. The extension reuses the person's browser.                                                                               |
