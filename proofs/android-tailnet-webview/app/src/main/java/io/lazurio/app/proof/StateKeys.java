package io.lazurio.app.proof;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A tailnet node's 32-byte state key, kept only sealed by the Android Keystore: the phone's
 * counterpart of ADR 0003, where the desktop app seals it with Electron's safeStorage.
 */
final class StateKeys {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "lazurio-tailnet-state-keys";

    private StateKeys() {}

    static byte[] stateKeyFor(File sealedFile) throws GeneralSecurityException, IOException {
        SecretKey wrapping = wrappingKey();
        if (sealedFile.exists()) {
            ByteBuffer sealed = ByteBuffer.wrap(Files.readAllBytes(sealedFile.toPath()));
            byte[] iv = new byte[12];
            sealed.get(iv);
            byte[] body = new byte[sealed.remaining()];
            sealed.get(body);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrapping, new GCMParameterSpec(128, iv));
            return cipher.doFinal(body);
        }
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrapping);
        byte[] body = cipher.doFinal(key);
        byte[] iv = cipher.getIV();
        File parent = sealedFile.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot make " + parent);
        }
        Files.write(sealedFile.toPath(), ByteBuffer.allocate(iv.length + body.length).put(iv).put(body).array());
        return key;
    }

    private static SecretKey wrappingKey() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
