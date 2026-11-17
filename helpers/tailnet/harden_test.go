package main

import (
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/envknob"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/nettype"

	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

func TestNodesAskNoRouterForAPort(t *testing.T) {
	NewNodes(func(*tailnetv1.NodeState) {}, slog.Default())
	if !envknob.Bool("TS_DISABLE_PORTMAPPER") {
		t.Fatal("the port mapper is on, so a node would ask the router to open a port")
	}
}

func TestCheckBuildRefusesABuildWithoutTheTags(t *testing.T) {
	if err := checkBuild(nil); err != nil {
		t.Fatalf("a build with every tag was refused: %v", err)
	}
	err := checkBuild([]string{"ts_omit_c2n", "ts_omit_peerapiserver"})
	if err == nil || err.Error() != "built without ts_omit_c2n,ts_omit_peerapiserver; build with `pnpm build:helpers`" {
		t.Fatalf("a build without tags was not refused by name: %v", err)
	}
}

func TestOmittedFeaturesNameEveryTagOfTheBuild(t *testing.T) {
	tags := make([]string, 0, len(omittedFeatures))
	for _, feature := range omittedFeatures {
		tags = append(tags, feature.tag)
	}
	// The same list scripts/lib/helper-build.ts passes to `go build -tags`.
	want := []string{"ts_omit_c2n", "ts_omit_netlog", "ts_omit_peerapiserver"}
	if !slices.Equal(tags, want) {
		t.Fatalf("tags %v, want %v", tags, want)
	}
}

// startTestDERP runs a DERP relay and a STUN server on the loopback, as tstest/integration's
// RunDERPAndSTUN does, without that package's many dependencies.
func startTestDERP(t *testing.T) *tailcfg.DERPMap {
	t.Helper()
	server := derpserver.New(key.NewNode(), logger.Discard)
	t.Cleanup(func() { _ = server.Close() })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := httptest.NewUnstartedServer(derpserver.Handler(server))
	_ = relay.Listener.Close()
	relay.Listener = listener
	relay.Config.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	relay.StartTLS()
	t.Cleanup(relay.Close)
	stunAddress, stopSTUN := stuntest.ServeWithPacketListener(t, nettype.Std{})
	t.Cleanup(stopSTUN)
	return &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
		1: {RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{
			Name:             "t1",
			RegionID:         1,
			HostName:         "127.0.0.1",
			IPv4:             "127.0.0.1",
			IPv6:             "none",
			STUNPort:         stunAddress.Port,
			DERPPort:         listener.Addr().(*net.TCPAddr).Port,
			InsecureForTests: true,
			STUNTestIP:       "127.0.0.1",
		}}},
	}}
}

// startTestControl runs a control server and a DERP relay on the loopback, as tsnet's own tests do.
func startTestControl(t *testing.T) string {
	t.Helper()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control := &testcontrol.Server{
		DERPMap:        startTestDERP(t),
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "tail-scale.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control.HTTPTestServer.URL
}

func startTestNode(t *testing.T, controlURL, hostname string, before func(*tsnet.Server)) (*tsnet.Server, netip.Addr) {
	t.Helper()
	server := &tsnet.Server{
		Dir:        filepath.Join(t.TempDir(), hostname),
		ControlURL: controlURL,
		Hostname:   hostname,
		Store:      new(mem.Store),
		Ephemeral:  true,
		Logf:       logger.Discard,
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	before(server)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, err := server.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return server, status.TailscaleIPs[0]
}

// echo answers each connection with what it reads.
func echo(t *testing.T, server *tsnet.Server, port string) {
	t.Helper()
	listener, err := server.Listen("tcp", ":"+port)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
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
	reply := make([]byte, 4)
	_, err = io.ReadFull(conn, reply)
	return err
}

func TestShieldsUpRefusesTheTailnetAndKeepsTheNodesOwnConnections(t *testing.T) {
	if testing.Short() {
		t.Skip("runs two tsnet nodes against a control server")
	}
	controlURL := startTestControl(t)
	app, appIP := startTestNode(t, controlURL, "app", func(server *tsnet.Server) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shieldsUp(ctx, server); err != nil {
			t.Fatal(err)
		}
	})
	environment, environmentIP := startTestNode(t, controlURL, "environment", func(*tsnet.Server) {})
	// Something listens on the app's node too, which the helper never does, so the refusal comes
	// from shields up and not from a closed port.
	echo(t, app, "8081")
	echo(t, environment, "8080")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := roundTrip(ctx, app, net.JoinHostPort(environmentIP.String(), "8080")); err != nil {
		t.Fatalf("the app's node cannot reach the Environment: %v", err)
	}

	refused, cancelRefused := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelRefused()
	if err := roundTrip(refused, environment, net.JoinHostPort(appIP.String(), "8081")); err == nil {
		t.Fatal("the tailnet reached a port on the app's node")
	}

	client, err := app.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	prefs, err := client.GetPrefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.ShieldsUp {
		t.Fatal("the app's node runs with shields up off")
	}
}
