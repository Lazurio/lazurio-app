//go:build windows

package main

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// The string value Tailnets under HKLM\SOFTWARE\Policies\Lazurio\App, which only an
// administrator writes.
const (
	policyKey   = `SOFTWARE\Policies\Lazurio\App`
	policyValue = "Tailnets"
)

// readPolicy reads the policy from the 64-bit view of the machine's registry, where policies for
// 64-bit Windows live; a key or value that does not exist is no policy.
func readPolicy() (string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, policyKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return "", errNoPolicy
	}
	if err != nil {
		return "", fmt.Errorf("open the policy key: %w", err)
	}
	defer func() { _ = key.Close() }()
	text, valueType, err := key.GetStringValue(policyValue)
	if errors.Is(err, registry.ErrNotExist) {
		return "", errNoPolicy
	}
	if err != nil {
		return "", fmt.Errorf("read the policy value (type %d): %w", valueType, err)
	}
	return text, nil
}
