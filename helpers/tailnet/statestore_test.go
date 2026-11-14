package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"tailscale.com/ipn"
)

// A stand-in for a private key, easy to find in a file.
var secretMarker = []byte("privkey:7f3a9c-not-a-real-key-but-a-marker")

func stateKeyForTest(fill byte) []byte {
	return bytes.Repeat([]byte{fill}, stateKeySize)
}

func TestSealedStoreKeepsNothingOfTheStateInTheClear(t *testing.T) {
	directory := t.TempDir()
	store, err := openSealedStore(directory, stateKeyForTest(1))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := store.WriteState("_machinekey", secretMarker); err != nil {
		t.Fatalf("write: %v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the directory: %v", err)
	}
	for _, entry := range entries {
		content, err := os.ReadFile(filepath.Join(directory, entry.Name())) //nolint:gosec // A file of the test's own temporary directory.
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		if bytes.Contains(content, secretMarker) || bytes.Contains(content, []byte("_machinekey")) {
			t.Fatalf("%s holds the state in the clear", entry.Name())
		}
	}
	info, err := os.Stat(filepath.Join(directory, sealedStateFile))
	if err != nil {
		t.Fatalf("stat the sealed state: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the sealed state has mode %v", info.Mode().Perm())
	}
}

func TestSealedStoreGivesTheStateBackAfterARestart(t *testing.T) {
	directory := t.TempDir()
	first, err := openSealedStore(directory, stateKeyForTest(2))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := first.WriteState("_machinekey", secretMarker); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := first.WriteState("_profiles", []byte("{}")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := first.WriteState("_profiles", nil); err != nil {
		t.Fatalf("delete: %v", err)
	}

	again, err := openSealedStore(directory, stateKeyForTest(2))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	value, err := again.ReadState("_machinekey")
	if err != nil || !bytes.Equal(value, secretMarker) {
		t.Fatalf("read = %q, %v", value, err)
	}
	if _, err := again.ReadState("_profiles"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("a deleted key reads as %v", err)
	}
}

func TestSealedStoreOpensOnlyWithItsKeyAndUntouched(t *testing.T) {
	directory := t.TempDir()
	store, err := openSealedStore(directory, stateKeyForTest(3))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := store.WriteState("_machinekey", secretMarker); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := openSealedStore(directory, stateKeyForTest(4)); err == nil {
		t.Fatal("another key opened the sealed state")
	}

	path := filepath.Join(directory, sealedStateFile)
	sealed, err := os.ReadFile(path) //nolint:gosec // The test's own temporary directory.
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	sealed[len(sealed)-1] ^= 0x01
	if err := os.WriteFile(path, sealed, 0o600); err != nil { //nolint:gosec // The test's own temporary directory.
		t.Fatalf("tamper: %v", err)
	}
	if _, err := openSealedStore(directory, stateKeyForTest(3)); err == nil {
		t.Fatal("a tampered sealed state opened")
	}
	if err := os.WriteFile(path, sealed[:5], 0o600); err != nil { //nolint:gosec // The test's own temporary directory.
		t.Fatalf("cut: %v", err)
	}
	if _, err := openSealedStore(directory, stateKeyForTest(3)); err == nil {
		t.Fatal("a cut sealed state opened")
	}
}

func TestSealedStoreTakesOverTheStateTsnetKeptInTheClear(t *testing.T) {
	directory := t.TempDir()
	plain, err := json.Marshal(map[ipn.StateKey][]byte{"_machinekey": secretMarker, "_current-profile": []byte("1a2b")})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, plainStateFile), plain, 0o600); err != nil {
		t.Fatalf("write the earlier state: %v", err)
	}

	store, err := openSealedStore(directory, stateKeyForTest(5))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := os.Stat(filepath.Join(directory, plainStateFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the earlier state in the clear is still there: %v", err)
	}
	value, err := store.ReadState("_machinekey")
	if err != nil || !bytes.Equal(value, secretMarker) {
		t.Fatalf("read = %q, %v", value, err)
	}
	sealed, err := os.ReadFile(filepath.Join(directory, sealedStateFile)) //nolint:gosec // The test's own temporary directory.
	if err != nil || bytes.Contains(sealed, secretMarker) {
		t.Fatalf("the taken-over state is not sealed: %v", err)
	}
	again, err := openSealedStore(directory, stateKeyForTest(5))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if value, err := again.ReadState("_current-profile"); err != nil || string(value) != "1a2b" {
		t.Fatalf("read after the take-over = %q, %v", value, err)
	}
}

func TestSealedStoreRefusesAKeyOfTheWrongSize(t *testing.T) {
	for _, size := range []int{0, 16, 31, 33} {
		if _, err := openSealedStore(t.TempDir(), make([]byte, size)); err == nil {
			t.Fatalf("a %d-byte key opened a store", size)
		}
	}
}
