// Command restart shows the node policy at work outside `go test`, where tailscale gives a node no
// policy client (testenv.InTest): a node with the policy runs with shields up as soon as Start
// returns, before anyone edits its preferences and before its first map, both when it first
// registers and when it starts again from its state on disk; and after the restart a peer of its
// tailnet cannot reach a port it listens on. The policy holds for the whole process, so the peer
// here has shields up too and the node's own connections are not tried; harden_test.go shows those
// with shields up. It prints "ok" and exits 0, or names the failure and exits 1.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"time"

	"github.com/Lazurio/lazurio-app/helpers/tailnet/internal/nodepolicy"
	"tailscale.com/derp/derpserver"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/stunserver"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	if err := run(); err != nil {
		fmt.Println("restart:", err)
		os.Exit(1)
	}
	fmt.Println("ok")
}

func run() error {
	nodepolicy.Install()
	netns.SetEnabled(false)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	controlURL, stop, err := startControl(ctx)
	if err != nil {
		return err
	}
	defer stop()
	root, err := os.MkdirTemp("", "nodepolicy-restart-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(root) }()

	// The app's node registers, stops, and starts again from its state on disk.
	first := node(root, controlURL, "app")
	if err := startShielded(ctx, first, "first start"); err != nil {
		_ = first.Close()
		return err
	}
	if _, err := first.Up(ctx); err != nil {
		_ = first.Close()
		return fmt.Errorf("first up: %w", err)
	}
	if err := first.Close(); err != nil {
		return fmt.Errorf("first close: %w", err)
	}

	again := node(root, controlURL, "app")
	defer func() { _ = again.Close() }()
	if err := startShielded(ctx, again, "restart"); err != nil {
		return err
	}
	status, err := again.Up(ctx)
	if err != nil {
		return fmt.Errorf("up after the restart: %w", err)
	}
	if err := echo(again, ":8081"); err != nil {
		return err
	}
	// The peer joins after the restart, so its map carries the restarted node's keys.
	environment := node(root, controlURL, "environment")
	environment.Store = new(mem.Store)
	environment.Ephemeral = true
	defer func() { _ = environment.Close() }()
	if err := environment.Start(); err != nil {
		return err
	}
	if _, err := environment.Up(ctx); err != nil {
		return fmt.Errorf("environment up: %w", err)
	}

	refused, cancelRefused := context.WithTimeout(ctx, 3*time.Second)
	defer cancelRefused()
	if err := roundTrip(refused, environment, net.JoinHostPort(status.TailscaleIPs[0].String(), "8081")); err == nil {
		return errors.New("the tailnet reached a port on the app's node after its restart")
	}
	return nil
}

func node(root, controlURL, hostname string) *tsnet.Server {
	return &tsnet.Server{
		Dir:        filepath.Join(root, hostname),
		ControlURL: controlURL,
		Hostname:   hostname,
		Logf:       logger.Discard,
	}
}

// startShielded starts the node and requires shields up at once, before anything edits its
// preferences: the policy applies when the backend starts.
func startShielded(ctx context.Context, server *tsnet.Server, when string) error {
	if err := server.Start(); err != nil {
		return fmt.Errorf("%s: %w", when, err)
	}
	client, err := server.LocalClient()
	if err != nil {
		return err
	}
	prefs, err := client.GetPrefs(ctx)
	if err != nil {
		return err
	}
	if !prefs.ShieldsUp {
		return fmt.Errorf("%s: the node started with shields up off", when)
	}
	return nil
}

func echo(server *tsnet.Server, address string) error {
	listener, err := server.Listen("tcp", address)
	if err != nil {
		return err
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return nil
}

func roundTrip(ctx context.Context, server *tsnet.Server, address string) error {
	conn, err := server.Dial(ctx, "tcp", address)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		return err
	}
	_, err = io.ReadFull(conn, make([]byte, 4))
	return err
}

// startControl runs a control server, a DERP relay and a STUN server on the loopback; the STUN
// server stops with ctx.
func startControl(ctx context.Context) (string, func(), error) {
	relayServer := derpserver.New(key.NewNode(), logger.Discard)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	relay := httptest.NewUnstartedServer(derpserver.Handler(relayServer))
	_ = relay.Listener.Close()
	relay.Listener = listener
	relay.Config.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	relay.StartTLS()

	stun := stunserver.New(ctx)
	if err := stun.Listen("127.0.0.1:0"); err != nil {
		relay.Close()
		return "", nil, err
	}
	go func() { _ = stun.Serve() }()

	control := &testcontrol.Server{
		DERPMap: &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
			1: {RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{
				Name:             "t1",
				RegionID:         1,
				HostName:         "127.0.0.1",
				IPv4:             "127.0.0.1",
				IPv6:             "none",
				STUNPort:         stun.LocalAddr().(*net.UDPAddr).Port,
				DERPPort:         listener.Addr().(*net.TCPAddr).Port,
				InsecureForTests: true,
				STUNTestIP:       "127.0.0.1",
			}}},
		}},
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "tail-scale.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	stop := func() {
		control.HTTPTestServer.Close()
		relay.Close()
		_ = relayServer.Close()
	}
	return control.HTTPTestServer.URL, stop, nil
}
