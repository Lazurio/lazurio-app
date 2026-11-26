// Command hostenv plays a small tailnet for the Android proof: a control server that asks every
// new node to sign in, a DERP relay with STUN, and one node that serves a page of a test
// Environment over HTTPS. It writes the test CA and the app's tailnet entry to its output folder.
//
// It is a proof's tool, not part of Lazurio App. It listens only on the address given by -bind,
// which on the station is the Docker bridge, reachable from the emulator and nothing outside.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"html"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/stun"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	bind := flag.String("bind", "172.17.0.1", "the only address to listen on")
	controlPort := flag.Int("control-port", 18443, "the control server's port")
	domain := flag.String("domain", "proof.lazurio.io", "the tailnet's MagicDNS domain")
	envName := flag.String("env", "lazurio-example", "the test Environment's host name")
	outDir := flag.String("out", "out", "folder for ca.pem and tailnet.json")
	noAuth := flag.Bool("no-auth", false, "register every node without a sign-in, for unattended runs")
	flag.Parse()
	// On Linux a node binds its control and DERP dials to the default route's interface, which
	// never reaches the Docker bridge; tsnet's own tests turn that off the same way.
	netns.SetEnabled(false)

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatal(err)
	}
	ca, caKey := loadOrNewCA(*outDir)

	bindIP := netip.MustParseAddr(*bind)
	controlCert := leaf(ca, caKey, nil, []net.IP{net.IP(bindIP.AsSlice())})
	envHost := *envName + "." + *domain
	envCert := leaf(ca, caKey, []string{envHost}, nil)

	derpMap := startDERP(*bind)

	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: *domain,
		RequireAuth:    !*noAuth,
		Logf:           envLogf(),
	}
	controlURL := fmt.Sprintf("https://%s:%d", *bind, *controlPort)
	control.ExplicitBaseURL = controlURL
	mux := http.NewServeMux()
	// The sign-in page stands in for Lazurio Auth: the person confirms, and only then does the
	// control server register the node.
	mux.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			ok := control.CompleteAuth(r.URL.Path)
			log.Printf("sign-in confirmed for %s: %v", r.URL.Path, ok)
			fmt.Fprint(w, page("Přihlášeno", "<p>Zařízení je přihlášené. Vraťte se do aplikace.</p>"))
			return
		}
		fmt.Fprint(w, page("Přihlášení (test)", `<p>Tato stránka v důkazu zastupuje Lazurio Auth.</p>
<form method="post"><button style="font-size:1.2em;padding:.6em 1.2em">Přihlásit telefon</button></form>`))
	})
	// testcontrol panics on any path it does not know, such as a browser's favicon.
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.Handle("/", control)
	controlServer := &http.Server{
		Addr:      fmt.Sprintf("%s:%d", *bind, *controlPort),
		Handler:   logRequests(mux),
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{controlCert}},
	}
	go func() { log.Fatal(controlServer.ListenAndServeTLS("", "")) }()

	entry := map[string]any{
		"tailnet":    "proof",
		"controlUrl": controlURL,
		"domains":    []string{*domain},
		"startUrl":   "https://" + envHost + "/",
	}
	data, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.WriteFile(filepath.Join(*outDir, "tailnet.json"), data, 0o644); err != nil {
		log.Fatal(err)
	}

	// The test Environment's node is signed in by this program, so only the phone's node goes
	// through the sign-in page.
	envNode := &tsnet.Server{
		Dir:        filepath.Join(*outDir, "env-node"),
		ControlURL: controlURL,
		Hostname:   *envName,
		Store:      new(mem.Store),
		Ephemeral:  true,
		Logf:       envLogf(),
	}
	// tsnet trusts the system's roots; the control server's certificate comes from the test CA.
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	http.DefaultTransport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: pool}
	if err := os.Setenv("SSL_CERT_FILE", filepath.Join(*outDir, "ca.pem")); err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	up := make(chan error, 1)
	go func() { _, err := envNode.Up(ctx); up <- err }()
	if err := signInOwnNode(ctx, envNode, control, up); err != nil {
		log.Fatalf("the Environment's node: %v", err)
	}
	listener, err := envNode.Listen("tcp", ":443")
	if err != nil {
		log.Fatal(err)
	}
	envMux := http.NewServeMux()
	envMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("Environment page served to %s for %s", r.RemoteAddr, r.URL.Path)
		fmt.Fprint(w, page("Lazurio Example – testovací Prostředí", fmt.Sprintf(
			`<p>Tuto stránku obsluhuje uzel <b>%s</b> jen uvnitř testovacího tailnetu.</p>
<p>Telefon ji načetl přes vestavěný uzel aplikace, adresa telefonu v tailnetu: <code>%s</code>.</p>`,
			html.EscapeString(envHost), html.EscapeString(strings.Split(r.RemoteAddr, ":")[0]))))
	})
	envServer := &http.Server{Handler: envMux}
	go func() {
		log.Fatal(envServer.Serve(tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{envCert}})))
	}()
	log.Printf("ready: control %s, Environment https://%s/", controlURL, envHost)
	select {}
}

// signInOwnNode confirms the sign-in of the test Environment's own node as soon as it asks.
func signInOwnNode(ctx context.Context, node *tsnet.Server, control *testcontrol.Server, up <-chan error) error {
	for {
		select {
		case err := <-up:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
		client, err := node.LocalClient()
		if err != nil {
			continue
		}
		if status, err := client.StatusWithoutPeers(ctx); err == nil && status.AuthURL != "" {
			control.CompleteAuth(status.AuthURL)
		}
	}
}

func page(title, body string) string {
	return fmt.Sprintf(`<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.5;background:#f6f7fb;color:#111}
h1{font-size:1.4em;color:#2a4bd7}code{background:#e8ebf5;padding:2px 4px;border-radius:4px}</style>
</head><body><h1>%s</h1>%s</body></html>`, html.EscapeString(title), html.EscapeString(title), body)
}

func startDERP(bind string) *tailcfg.DERPMap {
	server := derpserver.New(key.NewNode(), logger.Discard)
	listener, err := net.Listen("tcp", bind+":0")
	if err != nil {
		log.Fatal(err)
	}
	ca, caKey := newCA()
	cert := leaf(ca, caKey, nil, []net.IP{net.ParseIP(bind)})
	relay := &http.Server{
		Handler:      derpserver.Handler(server),
		TLSConfig:    &tls.Config{Certificates: []tls.Certificate{cert}},
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}
	go func() { log.Fatal(relay.ServeTLS(listener, "", "")) }()
	packets, err := net.ListenPacket("udp", bind+":0")
	if err != nil {
		log.Fatal(err)
	}
	go serveSTUN(packets)
	return &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
		1: {RegionID: 1, RegionCode: "proof", Nodes: []*tailcfg.DERPNode{{
			Name:             "p1",
			RegionID:         1,
			HostName:         bind,
			IPv4:             bind,
			IPv6:             "none",
			STUNPort:         packets.LocalAddr().(*net.UDPAddr).Port,
			DERPPort:         listener.Addr().(*net.TCPAddr).Port,
			InsecureForTests: true,
			STUNTestIP:       bind,
		}}},
	}}
}

func serveSTUN(packets net.PacketConn) {
	buffer := make([]byte, 1500)
	for {
		n, address, err := packets.ReadFrom(buffer)
		if err != nil {
			return
		}
		txID, err := stun.ParseBindingRequest(buffer[:n])
		if err != nil {
			continue
		}
		udp := address.(*net.UDPAddr)
		ip, _ := netip.AddrFromSlice(udp.IP)
		_, _ = packets.WriteTo(stun.Response(txID, netip.AddrPortFrom(ip.Unmap(), uint16(udp.Port))), address)
	}
}

// loadOrNewCA keeps the test CA between runs, so the app built with it keeps trusting the tailnet.
func loadOrNewCA(dir string) (*x509.Certificate, *ecdsa.PrivateKey) {
	certPEM, err1 := os.ReadFile(filepath.Join(dir, "ca.pem"))
	keyPEM, err2 := os.ReadFile(filepath.Join(dir, "ca-key.pem"))
	if err1 == nil && err2 == nil {
		certBlock, _ := pem.Decode(certPEM)
		keyBlock, _ := pem.Decode(keyPEM)
		if certBlock != nil && keyBlock != nil {
			cert, err := x509.ParseCertificate(certBlock.Bytes)
			privateKey, err2 := x509.ParseECPrivateKey(keyBlock.Bytes)
			if err == nil && err2 == nil {
				return cert, privateKey
			}
		}
	}
	cert, privateKey := newCA()
	writePEM(filepath.Join(dir, "ca.pem"), "CERTIFICATE", cert.Raw)
	der, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca-key.pem"),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		log.Fatal(err)
	}
	return cert, privateKey
}

func newCA() (*x509.Certificate, *ecdsa.PrivateKey) {
	privateKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "Lazurio App proof CA (test only)"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(7 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		log.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert, privateKey
}

func leaf(ca *x509.Certificate, caKey *ecdsa.PrivateKey, names []string, ips []net.IP) tls.Certificate {
	privateKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "proof"},
		DNSNames:     names,
		IPAddresses:  ips,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(7 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &privateKey.PublicKey, caKey)
	if err != nil {
		log.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: privateKey}
}

func writePEM(path, kind string, der []byte) {
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0o644); err != nil {
		log.Fatal(err)
	}
}

// logRequests logs each request to the control server when HOSTENV_DEBUG is set.
func logRequests(next http.Handler) http.Handler {
	if os.Getenv("HOSTENV_DEBUG") == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("control request %s %s from %s", r.Method, r.URL.Path, r.RemoteAddr)
		next.ServeHTTP(w, r)
	})
}

// envLogf shows the test Environment's node's log when HOSTENV_DEBUG is set.
func envLogf() logger.Logf {
	if os.Getenv("HOSTENV_DEBUG") != "" {
		return log.Printf
	}
	return logger.Discard
}
