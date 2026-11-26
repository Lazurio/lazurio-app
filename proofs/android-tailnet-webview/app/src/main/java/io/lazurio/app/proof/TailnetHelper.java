package io.lazurio.app.proof;

import android.util.Log;

import com.google.protobuf.ByteString;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import lazurio.app.helper.v1.Helper.AppMessage;
import lazurio.app.helper.v1.Helper.HelperMessage;
import lazurio.app.helper.v1.Helper.Shutdown;
import lazurio.app.tailnet.v1.Tailnet.StartNode;

/**
 * Starts Lazurio App's tailnet helper (helpers/tailnet, built for Android unchanged) as a child
 * process and speaks the helper protocol with it: size-delimited protobuf messages over its
 * standard input and output, exactly as the desktop app's main process does.
 */
final class TailnetHelper {
    interface Listener {
        void onMessage(HelperMessage message);

        void onEnded(String reason);
    }

    private static final String TAG = "LazurioTailnet";

    private final Process process;
    private final OutputStream toHelper;
    private final AtomicLong requestIds = new AtomicLong(1);

    private TailnetHelper(Process process) {
        this.process = process;
        this.toHelper = process.getOutputStream();
    }

    /** The helper ships as lib/<abi>/liblazurio_tailnet.so, which Android unpacks as a file. */
    static TailnetHelper start(File nativeLibraryDir, File cacheDir, String extraCertFile, Listener listener)
            throws IOException {
        File binary = new File(nativeLibraryDir, "liblazurio_tailnet.so");
        ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath());
        builder.environment().put("TMPDIR", cacheDir.getAbsolutePath());
        builder.environment().put("HOME", cacheDir.getAbsolutePath());
        if (extraCertFile != null) {
            // Only the proof's test tailnet: Go reads this file besides the system's CA folder.
            builder.environment().put("SSL_CERT_FILE", extraCertFile);
        }
        Process process = builder.start();
        TailnetHelper helper = new TailnetHelper(process);
        Thread reader = new Thread(() -> helper.read(process.getInputStream(), listener), "tailnet-helper-out");
        reader.setDaemon(true);
        reader.start();
        Thread log = new Thread(() -> forwardLog(process.getErrorStream()), "tailnet-helper-log");
        log.setDaemon(true);
        log.start();
        return helper;
    }

    private void read(InputStream in, Listener listener) {
        try {
            while (true) {
                HelperMessage message = HelperMessage.parseDelimitedFrom(in);
                if (message == null) {
                    listener.onEnded("the helper closed its output");
                    return;
                }
                listener.onMessage(message);
            }
        } catch (IOException error) {
            listener.onEnded("reading the helper failed: " + error.getMessage());
        }
    }

    /** The helper logs JSON lines without addresses; the proof passes them to logcat. */
    private static void forwardLog(InputStream err) {
        byte[] buffer = new byte[4096];
        StringBuilder line = new StringBuilder();
        try {
            int n;
            while ((n = err.read(buffer)) > 0) {
                for (int i = 0; i < n; i++) {
                    char c = (char) buffer[i];
                    if (c == '\n') {
                        Log.i(TAG, line.toString());
                        line.setLength(0);
                    } else {
                        line.append(c);
                    }
                }
            }
        } catch (IOException ignored) {
            // The helper ended.
        }
    }

    synchronized long startNode(String tailnet, String controlUrl, String hostname, File stateDirectory,
            List<String> domains, byte[] stateKey) throws IOException {
        long id = requestIds.getAndIncrement();
        AppMessage.newBuilder()
                .setRequestId(id)
                .setStartNode(StartNode.newBuilder()
                        .setTailnet(tailnet)
                        .setControlUrl(controlUrl)
                        .setHostname(hostname)
                        .setStateDirectory(stateDirectory.getAbsolutePath())
                        .addAllDomains(domains)
                        .setStateKey(ByteString.copyFrom(stateKey)))
                .build()
                .writeDelimitedTo(toHelper);
        toHelper.flush();
        return id;
    }

    synchronized void shutdown() {
        try {
            AppMessage.newBuilder()
                    .setRequestId(requestIds.getAndIncrement())
                    .setShutdown(Shutdown.getDefaultInstance())
                    .build()
                    .writeDelimitedTo(toHelper);
            toHelper.close();
        } catch (IOException ignored) {
            // The helper is already gone.
        }
        process.destroy();
    }
}
