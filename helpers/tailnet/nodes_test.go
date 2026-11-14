package main

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

func validRequest() *tailnetv1.StartNode {
	return &tailnetv1.StartNode{
		Tailnet:        "example",
		ControlUrl:     "https://headscale.example-org.lazurio.io",
		Hostname:       "alice-macbook-app",
		StateDirectory: "/var/lib/lazurio-app/tailnets/example",
		Domains:        []string{"example-org.lazurio.io"},
		StateKey:       make([]byte, stateKeySize),
	}
}

func TestValidateStartAcceptsAWholeRequest(t *testing.T) {
	if err := validateStart(validRequest()); err != nil {
		t.Fatalf("validateStart: %v", err)
	}
}

func TestValidateStartRefusesWhatCouldMisdirectTheNode(t *testing.T) {
	cases := map[string]func(*tailnetv1.StartNode){
		"no tailnet":            func(r *tailnetv1.StartNode) { r.Tailnet = "" },
		"plain http control":    func(r *tailnetv1.StartNode) { r.ControlUrl = "http://headscale.example-org.lazurio.io" },
		"control with password": func(r *tailnetv1.StartNode) { r.ControlUrl = "https://user:secret@headscale.example-org.lazurio.io" },
		"no hostname":           func(r *tailnetv1.StartNode) { r.Hostname = "" },
		"relative state":        func(r *tailnetv1.StartNode) { r.StateDirectory = "tailnets/example" },
		"no domains":            func(r *tailnetv1.StartNode) { r.Domains = nil },
		"a bare label":          func(r *tailnetv1.StartNode) { r.Domains = []string{"io"} },
		"no state key":          func(r *tailnetv1.StartNode) { r.StateKey = nil },
		"a short state key":     func(r *tailnetv1.StartNode) { r.StateKey = make([]byte, 16) },
	}
	for name, change := range cases {
		request := validRequest()
		change(request)
		if err := validateStart(request); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDialerForRoutesANameOnlyToItsTailnet(t *testing.T) {
	nodes := NewNodes(func(*tailnetv1.NodeState) {}, slog.Default())
	nodes.nodes["example"] = &node{tailnet: "example", domains: []string{"example-org.lazurio.io"}}
	nodes.nodes["other"] = &node{tailnet: "other", domains: []string{"other-org.lazurio.io"}}

	for name, want := range map[string]bool{
		"launchpad.alice.example-org.lazurio.io":  true,
		"LAUNCHPAD.Alice.Example-Org.Lazurio.IO.": true,
		"example-org.lazurio.io":                  true,
		"launchpad.bob.other-org.lazurio.io":      true,
		"evil-example-org.lazurio.io":             false,
		"example-org.lazurio.io.attacker.example": false,
		"example.com": false,
	} {
		if _, got := nodes.DialerFor(name); got != want {
			t.Errorf("%s: routed = %v, want %v", name, got, want)
		}
	}
}

func TestStartRefusesDomainsAnotherTailnetServes(t *testing.T) {
	nodes := NewNodes(func(*tailnetv1.NodeState) {}, slog.Default())
	nodes.nodes["example"] = &node{tailnet: "example", domains: []string{"example-org.lazurio.io"}}
	for _, domain := range []string{"example-org.lazurio.io", "team.example-org.lazurio.io", "lazurio.io"} {
		request := validRequest()
		request.Tailnet = "second"
		request.Domains = []string{domain}
		_, _, err := nodes.Start(request)
		if err == nil || !strings.Contains(err.Error(), "overlaps") {
			t.Errorf("%s: err = %v", domain, err)
		}
	}
}

func TestTsnetLogsNeverCarryAnAddress(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	for _, level := range []slog.Level{slog.LevelDebug, slog.LevelInfo} {
		tsnetLogf(logger, level)(
			"To start this tsnet server, restart with TS_AUTHKEY set, or go to: %s",
			"https://headscale.example-org.lazurio.io/register/hskey-secret-registration-id",
		)
		tsnetLogf(logger, level)("control: dialing %s and %s", "http://control.example:80/key?v=1", "derp://relay.example")
	}
	logged := output.String()
	for _, leak := range []string{"hskey-secret-registration-id", "headscale.example-org", "control.example", "relay.example"} {
		if strings.Contains(logged, leak) {
			t.Fatalf("the log carries %q:\n%s", leak, logged)
		}
	}
	if strings.Count(logged, "<address>") != 6 {
		t.Fatalf("expected six redacted addresses:\n%s", logged)
	}
}
