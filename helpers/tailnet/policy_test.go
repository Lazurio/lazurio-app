package main

import (
	"bytes"
	"errors"
	"testing"
)

func TestReadPolicyCommandWritesThePolicyAndNamesItsAbsence(t *testing.T) {
	const policy = `[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]`
	cases := []struct {
		name string
		read func() (string, error)
		code int
		out  string
	}{
		{"a policy", func() (string, error) { return policy, nil }, exitPolicy, policy},
		{"no policy", func() (string, error) { return "", errNoPolicy }, exitNoPolicy, ""},
		{"a failure", func() (string, error) { return "", errors.New("access denied") }, exitFailed, ""},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		if code := readPolicyCommand(c.read, &out, &errOut); code != c.code || out.String() != c.out {
			t.Fatalf("%s: code %d and %q, want %d and %q", c.name, code, out.String(), c.code, c.out)
		}
	}
}
