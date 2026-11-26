// The iOS proof: a WKWebView shows a page of an Environment that exists only inside a tailnet,
// through Lazurio App's tailnet helper linked as a library and its loopback proxy with a password.
// Launch argument `credential` gives the password to the data store's proxy configuration
// (iOS 17 ProxyConfiguration.applyCredential); `challenge` gives it only when WebKit asks.
// Every step goes to Documents/result.txt, which the CI script reads.

import Network
import UIKit
import WebKit

private let proxyRealm = "Lazurio App"

final class ProofViewController: UIViewController, WKNavigationDelegate {
    private let status = UILabel()
    private var web: WKWebView?
    private var proxy: (port: UInt16, username: String, password: String)?
    private var domains: [String] = []
    private var startURL: URL?
    private var visited: [String] = []
    private var timer: Timer?
    private var lastState = ""
    private let mode = CommandLine.arguments.contains("challenge") ? "challenge" : "credential"
    private let resultFile: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("result.txt")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        status.numberOfLines = 0
        status.font = .systemFont(ofSize: 11)
        status.backgroundColor = UIColor(red: 0.89, green: 0.91, blue: 0.98, alpha: 1)
        status.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(status)
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
        ])
        try? FileManager.default.removeItem(at: resultFile)
        note("mode: \(mode)")
        start()
    }

    private func start() {
        guard let url = Bundle.main.url(forResource: "tailnet", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tailnet = entry["tailnet"] as? String,
              let control = entry["controlUrl"] as? String,
              let start = entry["startUrl"] as? String,
              let domains = entry["domains"] as? [String]
        else {
            note("DONE FAIL no tailnet.json")
            return
        }
        self.domains = domains
        startURL = URL(string: start)
        // The proof's state key is random per start; the real app keeps it sealed by the Keychain.
        var key = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, key.count, &key)
        let stateDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tailnets/\(tailnet)")
        try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        let config: [String: Any] = [
            "tailnet": tailnet, "controlUrl": control, "hostname": "lazurio-app-iphone-simulator",
            "stateDirectory": stateDirectory.path, "domains": domains,
            "stateKeyHex": key.map { String(format: "%02x", $0) }.joined(),
        ]
        guard let configData = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: configData, encoding: .utf8),
              let raw = json.withCString({ LazurioTailnetStart(UnsafeMutablePointer(mutating: $0)) })
        else {
            note("DONE FAIL no answer from the helper")
            return
        }
        let answer = String(cString: raw)
        free(raw)
        guard let started = try? JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any],
              let port = started["port"] as? Int,
              let username = started["username"] as? String,
              let password = started["password"] as? String
        else {
            note("DONE FAIL the helper did not start: \(answer)")
            return
        }
        proxy = (UInt16(port), username, password)
        note("proxy on 127.0.0.1:\(port) with a password for this start")
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard let raw = LazurioTailnetState() else { return }
        let state = String(cString: raw)
        free(raw)
        if state != lastState {
            lastState = state
            note("node: \(state)")
        }
        if state.hasPrefix("running") {
            timer?.invalidate()
            showWeb()
        }
    }

    /// Only the tailnet's own names go to the proxy (matchDomains), as the desktop's PAC does.
    private func showWeb() {
        guard let proxy, let startURL, let port = NWEndpoint.Port(rawValue: proxy.port) else { return }
        let store = WKWebsiteDataStore.nonPersistent()
        var configuration = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
        configuration.matchDomains = domains
        if mode == "credential" {
            configuration.applyCredential(username: proxy.username, password: proxy.password)
        }
        store.proxyConfigurations = [configuration]
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = store
        let web = WKWebView(frame: .zero, configuration: webConfiguration)
        web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 4),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        self.web = web
        note("loading \(startURL.absoluteString)")
        web.load(URLRequest(url: startURL))
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        note("challenge: method \(space.authenticationMethod), proxy \(space.isProxy()), host \(space.host), realm \(space.realm ?? "-")")
        if let proxy, space.isProxy(), space.host == "127.0.0.1", space.realm == proxyRealm {
            note("answered the proxy's challenge")
            completionHandler(.useCredential,
                              URLCredential(user: proxy.username, password: proxy.password, persistence: .forSession))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let url = webView.url?.absoluteString ?? "-"
        note("page shown: \(url) – \"\(webView.title ?? "")\"")
        visited.append(url)
        // A second navigation in the same view, because a later navigation was reported to bypass
        // a data store's proxy.
        if visited.count == 1, let next = URL(string: "second", relativeTo: startURL) {
            webView.load(URLRequest(url: next))
        } else {
            let host = startURL?.host ?? "?"
            let ok = visited.count == 2 && visited.allSatisfy { $0.contains(host) }
                && webView.title?.contains("Lazurio Example") == true
            note(ok ? "DONE PASS" : "DONE FAIL")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        note("DONE FAIL navigation: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        note("DONE FAIL provisional: \(error.localizedDescription)")
    }

    private func note(_ line: String) {
        NSLog("LazurioProof: %@", line)
        DispatchQueue.main.async {
            let lines = ((self.status.text ?? "") + "\n• " + line).split(separator: "\n").suffix(10)
            self.status.text = lines.joined(separator: "\n")
        }
        if let handle = try? FileHandle(forWritingTo: resultFile) {
            handle.seekToEndOfFile()
            handle.write(Data((line + "\n").utf8))
            try? handle.close()
        } else {
            try? Data((line + "\n").utf8).write(to: resultFile)
        }
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = ProofViewController()
        window?.makeKeyAndVisible()
        return true
    }
}
