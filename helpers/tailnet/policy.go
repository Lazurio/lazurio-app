package main

import (
	"errors"
	"fmt"
	"io"
)

// The tailnets an Organization's IT sets on its Windows computers (docs/adr/0008, point 6), read
// through the registry's own API (policy_windows.go), so no program on the path or under a
// directory the environment names takes part. The app runs `lazurio-tailnet read-policy` and
// decides what to take from the text.

// errNoPolicy means the computer has no such policy.
var errNoPolicy = errors.New("no tailnet policy")

// Exit codes of read-policy: the policy is on standard output, there is none, or it cannot be read.
const (
	exitPolicy   = 0
	exitNoPolicy = 3
	exitFailed   = 4
)

// readPolicyCommand writes the policy's text and gives the exit code.
func readPolicyCommand(read func() (string, error), out io.Writer, errOut io.Writer) int {
	text, err := read()
	if errors.Is(err, errNoPolicy) {
		return exitNoPolicy
	}
	if err != nil {
		_, _ = fmt.Fprintln(errOut, err)
		return exitFailed
	}
	if _, err := io.WriteString(out, text); err != nil {
		return exitFailed
	}
	return exitPolicy
}
