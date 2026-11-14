package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// DialFunc opens a connection the way net.Dialer.DialContext does.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// Router gives the dialer of the tailnet that serves a host name, or false when no tailnet does.
type Router interface {
	DialerFor(hostname string) (DialFunc, bool)
}

const (
	proxyUsername = "lazurio-app"
	proxyRealm    = "Lazurio App"
	dialTimeout   = 15 * time.Second
)

// ipPattern matches an IPv4 or IPv6 address, with its port when it has one.
var ipPattern = regexp.MustCompile(`\[?\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b\]?(?::\d+)?|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`)

// redactNetworkAddresses keeps a dial error's words without any web or IP address, because the
// error of a tailnet's dial names its peers' addresses.
func redactNetworkAddresses(text string) string {
	return ipPattern.ReplaceAllString(redactAddresses(text), "<ip>")
}

// Proxy is the helper's local HTTP proxy. It listens only on the loopback address, accepts only
// CONNECT with its credentials, and sends a name only to the tailnet that serves it, so other
// processes on the computer cannot use it and nothing else on the web goes through it.
type Proxy struct {
	listener net.Listener
	server   *http.Server
	router   Router
	logger   *slog.Logger
	username string
	password string
}

// StartProxy listens on a free loopback port with credentials made for this start only. It logs
// why a tailnet could not reach a name, without any address.
func StartProxy(router Router, logger *slog.Logger) (*Proxy, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("make the proxy's password: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}
	proxy := &Proxy{
		listener: listener,
		router:   router,
		logger:   logger,
		username: proxyUsername,
		password: base64.RawURLEncoding.EncodeToString(secret),
	}
	proxy.server = &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = proxy.server.Serve(listener) }()
	return proxy, nil
}

// Port is the loopback port the proxy listens on.
func (p *Proxy) Port() uint32 {
	address, ok := p.listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0
	}
	return uint32(address.Port) //nolint:gosec // A TCP port always fits.
}

// Close stops the proxy.
func (p *Proxy) Close() error {
	return p.server.Close()
}

func (p *Proxy) authorized(header string) bool {
	encoded, found := strings.CutPrefix(header, "Basic ")
	if !found {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	expected := []byte(p.username + ":" + p.password)
	return subtle.ConstantTimeCompare(decoded, expected) == 1
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !p.authorized(r.Header.Get("Proxy-Authorization")) {
		w.Header().Set("Proxy-Authenticate", fmt.Sprintf("Basic realm=%q", proxyRealm))
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	if r.Method != http.MethodConnect {
		http.Error(w, "only CONNECT", http.StatusMethodNotAllowed)
		return
	}
	hostname, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "the target needs a host and a port", http.StatusBadRequest)
		return
	}
	dial, ok := p.router.DialerFor(hostname)
	if !ok {
		http.Error(w, "no tailnet serves this name", http.StatusForbidden)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dialTimeout)
	defer cancel()
	upstream, err := dial(ctx, "tcp", r.Host)
	if err != nil {
		p.logger.Warn("the tailnet could not reach a name", "name", hostname,
			"error", redactNetworkAddresses(err.Error()))
		http.Error(w, "the tailnet could not reach the target", http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(w, "the connection cannot be taken over", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	splice(client, buffered.Reader, upstream)
}

// splice copies both directions until either side closes, then closes both.
func splice(client net.Conn, fromClient *bufio.Reader, upstream net.Conn) {
	done := make(chan struct{}, 2)
	copyAndSignal := func(to io.Writer, from io.Reader) {
		// Either side closing ends the tunnel; the error says nothing more than that.
		_, _ = io.Copy(to, from)
		done <- struct{}{}
	}
	go copyAndSignal(upstream, fromClient)
	go copyAndSignal(client, upstream)
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}
