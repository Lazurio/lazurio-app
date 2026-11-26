# Lazurio App on the phone (Android and iOS): proposal

- **Status:** proposal for Matěj Suchánek, written by an agent for the coordinator of Lazurio App. Nothing here is decided.
- **Written:** 2026-11-26
- **Related:**
  - decisions 0240, 0241 and 0248 of the [Lazurio decision register](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/decision-register.md);
  - this repository's ADRs [0001](../adr/0001-technological-foundation.md) (foundation), [0002](../adr/0002-sign-in-pages.md) (which pages a view shows), [0003](../adr/0003-node-state-sealed.md) (sealed node state), [0005](../adr/0005-installers-updates-and-channels.md) (installers and channels), [0006](../adr/0006-agent-desktop.md) (Agent Desktop) and [0008](../adr/0008-tailnets-from-a-directory.md) (tailnets from a directory);
  - the proof on Android in [proofs/android-tailnet-webview](../../proofs/android-tailnet-webview/README.md).

Matěj's words of 2026-11-25: the phone app should also be a kind of browser that reaches the web Lazurio over the tailnet, on Android and iOS, and, if a tool exists, let an agent work on the phone as Agent Desktop does on a computer.

Facts carry a source. Estimates are marked **(estimate)**.

## In short

1. **The web Lazurio in a phone app with the built-in tailnet works without Tailscale, without a VPN and without any special permission.** On Android it is verified: the desktop app's own tailnet helper runs inside an Android app, and its WebView reaches a page that exists only in the tailnet through the helper's loopback proxy with a password (the proof). On iOS the same design works on the simulator, in this repository's CI without an Apple account: the helper linked as a library, and `WKWebView` through the proxy with the password of iOS 17. A real iPhone waits for the Apple membership.
2. **The phone app reuses the desktop app's network core, not its window.** The tailnet node, the proxy, the sealed state and the rules of pages are the same; the window, the tabs and the sign-in flows are the phone's own.
3. **Recommended shape:** an Expo app with one native module for the network and the web view, written so that GEN5's mobile app, which is Expo in the fork, takes the module over unchanged. The network core stays in Go and is shared with the desktop helper.
4. **Stores:** the Google Play account is ready. Everything on iOS, including TestFlight and installing on a phone, waits for the Apple Developer membership. Android can reach named people before any store review.
5. **An agent working on the phone:** possible on Android only outside Google Play, which has forbidden the accessibility API for autonomous agents since January 2026. iOS lets no app operate others; that stays as decision 0240 says.
6. **Order and size:** Android to named people in about two to three weeks of work, iOS one to two weeks after Apple's approval **(estimate)**.

## What the decisions already say

- **0248, Phones:** "The phone app has its own codebase, as T3 Code keeps its mobile app apart from the desktop, and follows the same principles: the same identity, the built-in node, the web Lazurio, pages without power and an update path to GEN5. An iPhone only operates Environments."
- **0241:** one identity `io.lazurio.app` on every system; the node needs no VPN, no administrator rights and no system network setting; the Device is approved by the Organization's Admin; GEN5's phone app is Expo and React Native from the fork.
- **0240:** Android may later allow the capability "Used by an Environment" through its accessibility service; iOS lets no application operate others.
- **The manual** already promises the phone: "telefon s iOS 17 a novějším nebo s Androidem" joins through Lazurio App with the built-in tailnet (`manual/mechanisms.md`, Telefon a počítač).

## 1. The network on the phone

### The options

| Way                                                                  | Android                                                                                                         | iOS                                                                              | Verdict                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A tsnet node inside the app and a loopback proxy with a password** | Verified (the proof)                                                                                            | Verified on the simulator (the proof); needs iOS 17                              | **Recommended.** The desktop app's design, with no permission and no VPN                          |
| The system's VPN slot (`VpnService`, Network Extension)              | Takes the phone's one VPN slot; Play's VPN policy applies                                                       | A packet tunnel extension, its own process with a memory limit, and the VPN icon | Against 0241 (no VPN, no change to the system's network, no conflict with an installed Tailscale) |
| A loopback proxy without a password                                  | Other apps can connect to `127.0.0.1` too; Android gives an app no way to tell who connected unless it is a VPN | The same, while the app runs                                                     | No. The reason Tauri was refused in ADR 0001                                                      |

### Android, as the proof shows

- **The helper runs unchanged.** `helpers/tailnet` builds for Android (arm64 and x86_64, about 21 MB). The proof starts it as a child process from the app's native library folder and speaks the helper protocol with it.
- **The WebView sends only the tailnet's names to the proxy** with androidx.webkit's `ProxyController` and a reverse bypass list, the counterpart of the desktop's PAC script. The list holds the tailnet's DNS suffixes; everything else goes directly.
- **The WebView answers the proxy's password itself** through `WebViewClient.onReceivedHttpAuthRequest`, which Android calls for the proxy's `407` with host `127.0.0.1` and the realm `Lazurio App`. A page never sees the password, and a process without it gets `407`.
- **The node's state key is sealed by the Android Keystore,** as ADR 0003 seals it with Electron's `safeStorage`.
- **Three things differ from a computer,** and the real app handles them as Tailscale's own Android app does:
  1. Android gives apps no netlink, so Go cannot list network interfaces (golang/go#40569). The app tells the node its networks and each change of them (`netmon.RegisterInterfaceGetter`), from `ConnectivityManager`.
  2. There is no `/etc/resolv.conf`. A cgo build for Android resolves through bionic and Android's DNS daemon.
  3. The node must not bind its dials to an interface; the Android build of tsnet does not.
- **A library, not a child process, in the real app.** Android allows executing a binary shipped as a native library, but only unpacked (`extractNativeLibs`), which makes the install larger, and iOS allows no child process at all. The real app links the node as a library on both systems (gomobile or a C archive, as Tailscale's `libtailscale` does, BSD-3-Clause).
- **In the background** Android may stop the process. The node then signs in again from its sealed state when the app opens, in about a second **(estimate)**. A browser needs no foreground service.

### iOS, as the simulator proof shows

The proof runs in this repository's CI on a macOS runner, on the iOS 26 simulator (iPhone 17 Pro), with no Apple account ([proofs/ios-tailnet-webview](../../proofs/ios-tailnet-webview/README.md), workflow `phone-proof-ios.yml`).

- **The node runs as a library in an ordinary app.** iOS lets an app start no child process, so `helpers/tailnet` is linked into a Swift app as a C archive; one added file replaces its standard input and output with two functions that call the helper's own nodes and proxy. No Network Extension and no entitlement.
- **The web view's proxy:** since iOS 17, `WKWebsiteDataStore.proxyConfigurations` takes Network framework's `ProxyConfiguration` (HTTP CONNECT) per data store ([Apple](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations)), with `matchDomains` for the tailnet's names only. That is the iOS 17 floor the manual already names.
- **The password works.** With `ProxyConfiguration.applyCredential`, `WKWebView` loaded the test Environment's page and then a second page in the same view, both through the proxy; the test Environment's log shows both served to the phone's tailnet address. This settles two public doubts for the simulator: WebKit bug [264309](https://bugs.webkit.org/show_bug.cgi?id=264309) (2023, credentials never sent) and a report of September 2026 that a later navigation bypasses the proxy ([theoden8/webspace_app#604](https://github.com/theoden8/webspace_app/pull/604)).
- **Without the password nothing loads.** In a second run without `applyCredential`, WebKit asked the app for the proxy's credentials (an `HTTPBasic` challenge with `isProxy`, host `127.0.0.1`, no realm); the proof did not answer it, and the page failed with an authentication error. So the proxy is not bypassed, and the app could also answer the challenge itself.
- **Not verified yet:** a real iPhone, which needs the Apple membership, and iOS 17 and 18, which the runner has as simulators too.
- **In the background** iOS suspends the app, and the node reconnects when it returns.

## 2. What to take over

| From                                  | What                                                                                                                                                                                                            | How                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `helpers/tailnet`                     | Nodes per tailnet, the proxy with its password and its routing by name, the sealed state store, the policy that a node accepts no connection, the redaction of addresses in logs, the build tags                | Move the code from `package main` into an importable package that the desktop helper and a mobile binding both use. The desktop helper's behaviour and protocol stay unchanged |
| `proto/`                              | The messages for a node's start, state and proxy                                                                                                                                                                | The mobile binding keeps the same messages, so the state machine and its tests are shared                                                                                      |
| `apps/desktop/src/main/Navigation.ts` | Lazurio's pages, the GitHub sign-in inside a Lazurio Auth sign-in, addresses without credentials (ADR 0002), the domains a directory may name (ADR 0008)                                                        | The rules are pure TypeScript and come over unchanged in an Expo app; the native side only asks them                                                                           |
| `TailnetDirectory` (ADR 0008)         | The built-in directory with Lazurio Example, the checks of control servers and suffixes                                                                                                                         | The same file and checks                                                                                                                                                       |
| `src/ui/messages.ts`                  | Texts in Czech and English, Lazurio's vocabulary                                                                                                                                                                | The same catalog                                                                                                                                                               |
| The fork's `apps/mobile`              | Expo 58 and React Native 0.88 with the fork's catalog, the EAS build profiles and variants, the config plugins (for example Android's network security config), the native-client CI, `react-native-webview` 14 | Build infrastructure and conventions only. Its features are T3 Code's chat client, which GEN5 brings, not GEN4                                                                 |

Not taken over: the desktop window, tabs and frames as they are drawn (the phone draws its own strip with the same rules of 0248), the Device helper (`helpers/device`), Electron's updater.

## 3. Recommended shape of the app

- **An Expo app with one native module, `lazurio-tailnet`.** The module holds the node (Go, as a library), the proxy and the web view with its proxy and its answer to the password, in Kotlin and Swift, behind a small TypeScript interface.
  - Why a native web view of its own: `react-native-webview` exposes neither the iOS data store's proxy nor the Android answer to the proxy's challenge.
  - Why Expo: GEN5's phone app is Expo in the fork (0241). The module moves into it unchanged, as GEN5's desktop app starts the desktop helpers unchanged (0248). The rules of pages, the directory and the texts are TypeScript already.
- **Languages:** TypeScript, Go and, for the module only, Kotlin and Swift, each forced by one fact: the web view's proxy and the Keystore exist only in the platform's own language. This is a deviation from ADR 0001's three languages and needs a decision.
- **Where:** in this repository, as `apps/mobile` and a Go binding next to `helpers/tailnet`, so that the node's code is one Go module **(recommended)**. A separate repository would have to vendor or publish the node's package.
- **Identity:** `io.lazurio.app` on both stores, from the first build. A store replaces an app by its identity and signature, whatever it is built with, so GEN5 can come as an update. Keys sealed by the Keystore or the Keychain (with an access group of the same team) stay readable by GEN5.
- **Pages hold no power:** no JavaScript bridge in the web view, no file access, the navigation rules of ADR 0002, other addresses to the system's browser, no permission granted to a page.

## 4. Sign-in, approval and several Organizations

- **Two sign-ins, as ADR 0008 point 7 decided for the desktop:** the node signs in in the system's browser (Custom Tabs on Android, `ASWebAuthenticationSession` on iOS), and the Environment signs in in the app's web view through its gateway, Lazurio Auth and GitHub (ADR 0002). The proof showed the first on Android against Lazurio Example: the node's sign-in opened Lazurio Auth and then GitHub's sign-in.
- **Passkeys:** Android's WebView offers WebAuthn when the app turns it on (`WebSettingsCompat.setWebAuthenticationSupport`). In iOS's `WKWebView` a passkey works only for a site the app is associated with, so a GitHub passkey does not work in the app; a password with two-factor does **(to verify in step 2)**.
- **Approval of the Device** stays the Admin's (0245): the app shows that it waits for approval and names the Admin (0241). The node's name is `lazurio-app-<model>` on Android (`Build.MODEL`, the proof's `lazurio-app-sdk-gphone64-x86-64`). iOS gives apps only "iPhone" as the device's name since iOS 16, so the app asks the person for a name at the first start **(proposal)**.
- **Several Organizations:** one node per tailnet, all at once, as on the desktop. The list of tailnets:
  - now the built-in directory (Lazurio Example);
  - IT's counterpart of the Windows and Mac policy: Android's managed configurations and iOS's managed app configuration, both set by the Organization's device management;
  - the person's own setting: a code to scan in the app's native screen, never a link a page could open;
  - the target: the directory at Lazurio Auth (task 644), with which the exceptions end, as on the desktop.

## 5. Signing and the stores

### Where the accounts stand

From [HumanAndMachine-ai/HumanAndMachine-ai_GEN3#320](https://github.com/HumanAndMachine-ai/HumanAndMachine-ai_GEN3/issues/320), kept by the thread for signing apps:

- **Google Play:** the developer account of the company is paid, the identity, website and phone are verified (17. 11. 2026), and the console offers "create the first app".
- **Apple Developer:** the enrolment is pending (25. 11. 2026), and the membership is neither active nor paid.

### What it costs and how long it takes

| Step                          | Google Play                                                                                                                                                                                                                                                                                     | Apple                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account                       | 25 USD once, done                                                                                                                                                                                                                                                                               | 99 USD a year; waits for Apple's approval                                                                                                                                            |
| Before the first release      | The app's listing, privacy policy, data safety form, content rating, and since 31. 8. 2026 a target of Android 16, API 36 ([Google](https://support.google.com/googleplay/android-developer/answer/11926878))                                                                                   | App ID `io.lazurio.app`, certificates, App Store Connect record, privacy labels, export compliance answers (the app carries WireGuard and TLS, standard encryption)                  |
| Testing without public review | Internal testing for up to 100 testers, usually available within hours **(estimate)**; closed testing with a review. The rule of 12 testers for 14 days before production applies to personal accounts made after 13. 11. 2023, not to a company's                                              | TestFlight: internal testers (up to 100 members of the team) without review; external testers (up to 10,000) after a beta review, usually about a day **(estimate)**                 |
| Review for the store          | New apps of new accounts can take several days, sometimes a week or more **(estimate)**                                                                                                                                                                                                         | Typically one to two days **(estimate)**. A risk: guideline 4.2 refuses apps that are only a website in a frame; the built-in tailnet and native parts argue against that            |
| Before any store              | A signed APK installs on any Android phone today. Google's developer verification of sideloaded apps started in four countries on 30. 9. 2026 and goes worldwide in 2027 ([Android Developers](https://developer.android.com/developer-verification/guides)); a verified Play account covers it | Nothing on a real iPhone: Ad Hoc builds (100 devices a year), TestFlight and custom apps through Apple Business Manager all need the membership. Only the simulator works without it |

### What exactly waits for Apple

1. The active membership of Human and Machine s.r.o. in the Apple Developer Program.
2. Registering the App ID `io.lazurio.app` and a Keychain access group under the team.
3. A distribution certificate and provisioning profiles, kept by the signing thread like the Developer ID.
4. The App Store Connect record, TestFlight, and the export compliance answers.

The code, the simulator proof and the CI build for the simulator do not wait.

### One decision before the first Android build reaches anyone

An Android app keeps its signing key for life: a phone installs an update only with the same signature. If named people get an APK before Google Play, Play's later build must carry the same signature, or they have to uninstall and lose their sign-in. Play App Signing allows uploading the company's own app signing key instead of Google's. **Recommended:** make that key once, keep it where the signing thread keeps the others, use it for the APKs and for Play.

## 6. An agent working on the phone

### Android

- **Technically it works** with an accessibility service: the screen's tree, taps and gestures (`dispatchGesture`), text, and since Android 11 screenshots (`AccessibilityService.takeScreenshot`), without screen recording. The phone opens the channel to its Environment, as Agent Desktop does (contract v3, ADR 0006), so nothing connects into it (0240).
- **Google Play forbids it.** The policy on the accessibility API: "Any use of the Accessibility API that enables an app to autonomously initiate, plan, and execute actions or decisions is strictly prohibited", apart from deterministic scripts written by a person and tools whose core purpose is to help people with disabilities ([Google Play](https://support.google.com/googleplay/android-developer/answer/10964491)). A third-party summary dates it to January 2026.
- **Android 16's Advanced Protection** refuses accessibility services that are not accessibility tools, on phones where the person turned it on.
- **What is real:** a separate app, "Lazurio Device for Android", distributed outside Google Play (a signed APK or the Organization's device management) for named people, with the switch only in the app, the indicator in the status bar, Stop, and a history without content, as 0240 and 0248 require. Google's developer verification will need the same verified account for it from 2027.
- **Tools:**

| Tool                                                                                                                               | License    | What it is                                                            | For us                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Mobilerun Portal](https://github.com/droidrun/mobilerun-portal) (DroidRun)                                                        | AGPL-3.0   | An accessibility service app that gives an agent the tree and actions | A good model, but AGPL does not fit an app under the Elastic License; we would write our own                         |
| [Mobilerun](https://github.com/droidrun/mobilerun)                                                                                 | MIT        | The agent framework on the computer that drives the Portal            | Ideas for tools; the agent side runs in the Environment anyway                                                       |
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp)                                                                            | Apache-2.0 | An MCP server that drives Android and iOS over adb and Xcode          | Needs a computer connected to the phone, so it connects into the Device: only for the Organization's own test phones |
| [scrcpy](https://github.com/Genymobile/scrcpy), [appium-uiautomator2-server](https://github.com/appium/appium-uiautomator2-server) | Apache-2.0 | Screen and control over adb; UI automation through instrumentation    | Testing tools, the same limit as mobile-mcp                                                                          |
| [agent-device](https://github.com/callstack/agent-device)                                                                          | MIT        | A device layer for coding agents over simulators and emulators        | For developing this app, not for people's phones                                                                     |
| `Lazurio/agent-desktop` (fork of vercel-labs/agent-desktop)                                                                        | Apache-2.0 | macOS, Windows, Linux                                                 | Has no Android                                                                                                       |

### iOS

- **No app may operate other apps**, so the capability does not exist on iOS (0240). XCUITest and WebDriverAgent operate an iPhone only from a Mac with Xcode and a developer's signature; device management installs and configures apps but cannot tap.
- **What exists is narrow:** the app can offer its own App Intents to Shortcuts, and a Shortcut the person built can be started by name. That gives an agent named, prepared actions, not the phone **(estimate of usefulness: low)**.

## 7. Order and estimates

Each step is one pull request with its own review, as in this repository.

| Step | What                                                                                                                                               | Size **(estimate)** | Waits for                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------ |
| 0    | The proof on Android (this PR)                                                                                                                     | done                | —                                                      |
| 1    | The proof on the iOS simulator in CI: tsnet as a library, `WKWebView` with the proxy and its password, against the test tailnet (this PR)          | done                | —                                                      |
| 2    | The node's code as a package shared by the desktop helper and a mobile binding; the interface list and network changes from the app; tests on both | 2–3 days            | Matěj's decision on shape and languages                |
| 3    | The Android app: Expo shell, the native module, the rules of pages, the two sign-ins, waiting for approval, several tailnets, Czech and English    | 5–7 days            | step 2                                                 |
| 4    | A trial on real Android phones against Lazurio Example, end to end, with an approved Device                                                        | 1–2 days            | a member account and an Owner's approval               |
| 5    | Android to named people (signed APK) and Google Play internal testing                                                                              | 1–2 days            | the signing key decision; Matěj's word on Publication  |
| 6    | The iOS app on the same module, then TestFlight                                                                                                    | 3–5 days            | the Apple membership for anything beyond the simulator |
| 7    | Store releases                                                                                                                                     | 2 days + review     | Matěj's word on Publication                            |
| 8    | Android: Lazurio Device, an agent on the phone, outside Google Play, for a named pilot                                                             | 1–2 weeks           | Matěj's decision that it is wanted                     |

That is about two to three weeks of work to Android for named people and one to two weeks more for iOS once Apple has approved **(estimate)**, sharing the station's subscription with client work.

## Questions for Matěj

1. **The shape:** an Expo app with one native module that GEN5 takes over **(recommended)**, or two thin native apps (Kotlin and Swift) without React Native, which are smaller now and mean more work at GEN5.
2. **The languages:** Kotlin and Swift for the native module only, beside TypeScript and Go: a deviation from ADR 0001 forced by the platforms. Accept?
3. **The place:** `apps/mobile` in this repository **(recommended)**, or a repository of its own.
4. **Android before the store:** may named people get a signed APK before Google Play, with the company's own signing key that Play then uses too **(recommended)**?
5. **An agent on Android:** pursue the separate app outside Google Play now, after the first version **(recommended)**, or not at all?
