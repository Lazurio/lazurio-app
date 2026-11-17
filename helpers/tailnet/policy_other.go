//go:build !windows

package main

// readPolicy finds no policy where Windows' registry does not exist.
func readPolicy() (string, error) {
	return "", errNoPolicy
}
