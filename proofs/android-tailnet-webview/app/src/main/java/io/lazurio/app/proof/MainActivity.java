package io.lazurio.app.proof;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import lazurio.app.helper.v1.Helper.HelperMessage;
import lazurio.app.tailnet.v1.Tailnet.NodeState;
import lazurio.app.tailnet.v1.Tailnet.ProxyEndpoint;

/**
 * The proof: one WebView shows a page of an Environment that exists only inside a tailnet. The
 * page reaches it through Lazurio App's own tailnet helper and its loopback proxy, which asks for
 * a password made for this start. The WebView has no JavaScript bridge: pages hold no power.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "LazurioProof";
    private static final String PROXY_REALM = "Lazurio App";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final StringBuilder log = new StringBuilder();
    private TextView status;
    private WebView web;
    private TailnetHelper helper;
    private ProxyEndpoint proxy;
    private JSONObject tailnet;
    private boolean proxyReady;
    private boolean nodeRunning;
    private boolean loaded;
    private int proxyAuthAnswers;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setTextSize(11);
        status.setTextColor(Color.rgb(20, 30, 60));
        status.setBackgroundColor(Color.rgb(226, 232, 250));
        status.setPadding(24, 48, 24, 16);
        web = new WebView(this);
        layout.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        layout.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(layout);
        configureWebView();

        String name = getIntent().getStringExtra("tailnet");
        try {
            tailnet = readTailnet(name == null ? "proof" : name);
            note("tailnet: " + tailnet.getString("tailnet"));
            File extraCa = null;
            if ("proof".equals(tailnet.getString("tailnet"))) {
                extraCa = new File(getCacheDir(), "proof_ca.pem");
                try (InputStream in = getResources().openRawResource(R.raw.proof_ca)) {
                    java.nio.file.Files.copy(in, extraCa.toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
            helper = TailnetHelper.start(new File(getApplicationInfo().nativeLibraryDir), getCacheDir(),
                    extraCa == null ? null : extraCa.getAbsolutePath(), new TailnetHelper.Listener() {
                        @Override
                        public void onMessage(HelperMessage message) {
                            main.post(() -> handle(message));
                        }

                        @Override
                        public void onEnded(String reason) {
                            main.post(() -> note("helper ended: " + reason));
                        }
                    });
        } catch (Exception error) {
            note("start failed: " + error);
            Log.e(TAG, "start failed", error);
        }
    }

    private JSONObject readTailnet(String name) throws Exception {
        try (InputStream in = getAssets().open("tailnets/" + name + ".json")) {
            return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                // The proxy's challenge: answer it only for our own loopback proxy and its realm.
                if (proxy != null && "127.0.0.1".equals(stripPort(host)) && PROXY_REALM.equals(realm)) {
                    proxyAuthAnswers++;
                    note("proxy asked for its password (host " + host + ", realm \"" + realm
                            + "\"), answered " + proxyAuthAnswers + "x");
                    handler.proceed(proxy.getUsername(), proxy.getPassword());
                    return;
                }
                note("refused an auth request from " + host + " realm \"" + realm + "\"");
                handler.cancel();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLazurioPage(uri)) {
                    return false;
                }
                note("not Lazurio, handed to the system: " + uri.getHost());
                openOutside(uri);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                note("page shown: " + url + " – \"" + view.getTitle() + "\"");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    note("page error " + error.getErrorCode() + ": " + error.getDescription());
                }
            }
        });
    }

    private void handle(HelperMessage message) {
        switch (message.getKindCase()) {
            case HELLO:
                note("helper: " + message.getHello().getHelperName() + " " + message.getHello().getHelperVersion()
                        + ", protocol " + message.getHello().getProtocolVersion());
                break;
            case PROXY_ENDPOINT:
                proxy = message.getProxyEndpoint();
                note("proxy on 127.0.0.1:" + proxy.getPort() + " with a password for this start");
                applyProxy();
                startNode();
                break;
            case NODE_STATE:
                onNodeState(message.getNodeState());
                break;
            case FAILURE:
                note("helper failure " + message.getFailure().getCode() + ": " + message.getFailure().getMessage());
                break;
            default:
                break;
        }
    }

    /** Only the tailnet's own names go to the proxy (reverse bypass), as the desktop's PAC does. */
    private void applyProxy() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) {
            note("this WebView cannot set a proxy for chosen names");
            return;
        }
        try {
            ProxyConfig.Builder builder = new ProxyConfig.Builder()
                    .addProxyRule("127.0.0.1:" + proxy.getPort())
                    .setReverseBypassEnabled(true);
            JSONArray domains = tailnet.getJSONArray("domains");
            for (int i = 0; i < domains.length(); i++) {
                builder.addBypassRule(domains.getString(i));
                builder.addBypassRule("*." + domains.getString(i));
            }
            ProxyController.getInstance().setProxyOverride(builder.build(), main::post, () -> {
                proxyReady = true;
                note("WebView sends the tailnet's names to the proxy");
                maybeLoad();
            });
        } catch (Exception error) {
            note("proxy setting failed: " + error);
        }
    }

    private void startNode() {
        try {
            String name = tailnet.getString("tailnet");
            List<String> domains = new ArrayList<>();
            JSONArray array = tailnet.getJSONArray("domains");
            for (int i = 0; i < array.length(); i++) {
                domains.add(array.getString(i));
            }
            File tailnets = new File(getFilesDir(), "tailnets");
            byte[] stateKey = StateKeys.stateKeyFor(new File(tailnets, name + ".key"));
            helper.startNode(name, tailnet.getString("controlUrl"), nodeName(), new File(tailnets, name),
                    domains, stateKey);
            note("node " + nodeName() + " starting");
        } catch (Exception error) {
            note("node start failed: " + error);
        }
    }

    private void onNodeState(NodeState state) {
        switch (state.getStateCase()) {
            case STARTING:
                note("node: starting");
                break;
            case NEEDS_LOGIN:
                String loginUrl = state.getNeedsLogin().getLoginUrl();
                Uri login = Uri.parse(loginUrl);
                try {
                    Uri control = Uri.parse(tailnet.getString("controlUrl"));
                    if (!"https".equals(login.getScheme()) || !control.getHost().equals(login.getHost())) {
                        note("node: refused a login address outside its control server");
                        return;
                    }
                } catch (Exception error) {
                    return;
                }
                note("node: needs sign-in at its control server " + login.getHost());
                openLogin(login);
                break;
            case RUNNING:
                nodeRunning = true;
                note("node: running, tailnet address " + String.join(", ", state.getRunning().getAddressesList()));
                maybeLoad();
                break;
            case STOPPED:
                note("node: stopped: " + state.getStopped().getReason());
                break;
            default:
                break;
        }
    }

    private void maybeLoad() {
        if (!proxyReady || !nodeRunning || loaded) {
            return;
        }
        loaded = true;
        try {
            String start = tailnet.getString("startUrl");
            note("loading " + start);
            web.loadUrl(start);
        } catch (Exception error) {
            note("no start page: " + error);
        }
    }

    /**
     * The real app signs a node in in the system's browser, as the desktop app does. The test
     * tailnet's control server has a certificate from the proof's own CA, which only this
     * debuggable build trusts, so the proof shows that sign-in page in the app's WebView instead.
     */
    private void openLogin(Uri login) throws IllegalStateException {
        try {
            if ("proof".equals(tailnet.getString("tailnet"))) {
                note("(proof) the test sign-in page opens inside the app");
                web.loadUrl(login.toString());
                return;
            }
        } catch (Exception ignored) {
            // Falls through to the system's browser.
        }
        openOutside(login);
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            note("no browser on this phone for " + uri.getHost());
        }
    }

    /** Lazurio's pages of ADR 0002, point 1: https, no credentials, Lazurio's own names. */
    static boolean isLazurioPage(Uri uri) {
        if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getHost() == null) {
            return false;
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return host.equals("lazurio.io") || host.endsWith(".lazurio.io")
                || host.equals("lazurio.app") || host.endsWith(".lazurio.app")
                || host.equals("auth.lazurio.ai") || host.equals("dashboard.lazurio.ai");
    }

    private static String stripPort(String host) {
        int colon = host.lastIndexOf(':');
        return colon > 0 ? host.substring(0, colon) : host;
    }

    private static String nodeName() {
        String model = Build.MODEL.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]+", "-").replaceAll("^-+|-+$", "");
        return "lazurio-app-" + (model.isEmpty() ? "phone" : model);
    }

    private void note(String line) {
        Log.i(TAG, line);
        log.append("• ").append(line).append('\n');
        String[] lines = log.toString().split("\n");
        StringBuilder last = new StringBuilder();
        for (int i = Math.max(0, lines.length - 9); i < lines.length; i++) {
            last.append(lines[i]).append('\n');
        }
        status.setText(last.toString().trim());
    }

    @Override
    protected void onDestroy() {
        if (helper != null) {
            helper.shutdown();
        }
        super.onDestroy();
    }
}
