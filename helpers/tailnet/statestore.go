package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"tailscale.com/atomicfile"
	"tailscale.com/ipn"
)

const (
	// stateKeySize is the size of a node's state key, for AES-256-GCM.
	stateKeySize = 32
	// sealedStateFile holds a node's whole state, sealed with its state key.
	sealedStateFile = "state.sealed"
	// plainStateFile is where tsnet's own store kept a node's state in the clear before ADR 0003.
	plainStateFile = "tailscaled.state"
	// sealedStateFormat binds the sealed bytes to this format, as the cipher's additional data.
	sealedStateFormat = "lazurio-tailnet-state-v1"
)

// errStateUnreadable is a sealed state that does not open with the node's key: the key changed,
// or the file is damaged. The app shows the person how to start the node afresh.
var errStateUnreadable = errors.New("the sealed state does not open with this state key")

// sealedStore is a node's ipn.StateStore. It keeps the whole state, the node's machine and node
// keys among it, in one file sealed with AES-256-GCM under the node's state key (ADR 0003). The
// key comes from the app, which keeps it only sealed by the system's keystore, so the state
// directory alone gives nothing of the node away.
type sealedStore struct {
	mu    sync.Mutex
	path  string
	aead  cipher.AEAD
	state map[ipn.StateKey][]byte
}

// openSealedStore opens the node's sealed state in directory. A node that kept its state in the
// clear before has it sealed now, and the clear file removed.
func openSealedStore(directory string, key []byte) (*sealedStore, error) {
	if len(key) != stateKeySize {
		return nil, fmt.Errorf("the state key must be %d bytes", stateKeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("make the state cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("make the state cipher: %w", err)
	}
	store := &sealedStore{
		path:  filepath.Join(directory, sealedStateFile),
		aead:  aead,
		state: map[ipn.StateKey][]byte{},
	}
	sealed, err := os.ReadFile(store.path)
	switch {
	case err == nil:
		if err := store.unseal(sealed); err != nil {
			return nil, err
		}
		// A take-over that stopped after sealing left the clear file behind. It goes now, and a node
		// whose clear file cannot go does not start. The sealed state wins: a build that kept the
		// state in the clear may have written that file since, and its state is discarded.
		if err := removePlainState(directory); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		if err := store.takeOverPlainState(directory); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("read the sealed state: %w", err)
	}
	return store, nil
}

func (s *sealedStore) unseal(sealed []byte) error {
	size := s.aead.NonceSize()
	if len(sealed) < size {
		return fmt.Errorf("%w: it is cut short", errStateUnreadable)
	}
	plain, err := s.aead.Open(nil, sealed[:size], sealed[size:], []byte(sealedStateFormat))
	if err != nil {
		return errStateUnreadable
	}
	if err := json.Unmarshal(plain, &s.state); err != nil {
		return fmt.Errorf("%w: it holds no state", errStateUnreadable)
	}
	return nil
}

// takeOverPlainState seals the state that tsnet's own store kept in the clear, then removes the
// clear file. Without one, the node starts with an empty state.
func (s *sealedStore) takeOverPlainState(directory string) error {
	plainPath := filepath.Join(directory, plainStateFile)
	plain, err := os.ReadFile(plainPath) //nolint:gosec // The node's own state directory, which validateStart checks, and a fixed name.
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read the earlier state: %w", err)
	}
	if err := json.Unmarshal(plain, &s.state); err != nil {
		return fmt.Errorf("the earlier state holds no state: %w", err)
	}
	if err := s.persist(); err != nil {
		return err
	}
	return removePlainState(directory)
}

// removePlainState removes the state that tsnet's own store kept in the clear, if it is there.
func removePlainState(directory string) error {
	err := os.Remove(filepath.Join(directory, plainStateFile))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove the earlier state in the clear: %w", err)
	}
	return nil
}

// persist seals the whole state with a fresh nonce and replaces the file in one step.
func (s *sealedStore) persist() error {
	plain, err := json.Marshal(s.state)
	if err != nil {
		return fmt.Errorf("encode the state: %w", err)
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("make a nonce: %w", err)
	}
	sealed := s.aead.Seal(nonce, nonce, plain, []byte(sealedStateFormat))
	if err := atomicfile.WriteFile(s.path, sealed, 0o600); err != nil {
		return fmt.Errorf("write the sealed state: %w", err)
	}
	return nil
}

// ReadState returns the state kept under id, or ipn.ErrStateNotExist.
func (s *sealedStore) ReadState(id ipn.StateKey) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.state[id]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return bytes.Clone(value), nil
}

// WriteState keeps value under id, or removes id for a nil value, and seals the whole state. A
// failed write leaves the state as it was.
func (s *sealedStore) WriteState(id ipn.StateKey, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, had := s.state[id]
	if value == nil {
		delete(s.state, id)
	} else {
		s.state[id] = bytes.Clone(value)
	}
	if err := s.persist(); err != nil {
		if had {
			s.state[id] = previous
		} else {
			delete(s.state, id)
		}
		return err
	}
	return nil
}
