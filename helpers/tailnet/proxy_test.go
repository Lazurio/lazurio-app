package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// routeTo routes the names of one domain to a dialer, and nothing else.
type routeTo struct {
	domain string
	dial   DialFunc
}

func (r routeTo) DialerFor(hostname string) (DialFunc, bool) {
	if hostname == r.domain || strings.HasSuffix(hostname, "."+r.domain) {
		return r.dial, true
	}
	return nil, false
}

// echoServer answers every line with the same line, prefixed.
func echoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = connection.Close() }()
				reader := bufio.NewReader(connection)
				line, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				_, _ = fmt.Fprintf(connection, "echo %s", line)
			}()
		}
	}()
	return listener.Addr().String()
}

// lockedBuffer collects a logger's output from the proxy's goroutines.
type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func startTestProxy(t *testing.T, router Router) *Proxy {
	t.Helper()
	return startLoggingTestProxy(t, router, &lockedBuffer{})
}

func startLoggingTestProxy(t *testing.T, router Router, log io.Writer) *Proxy {
	t.Helper()
	proxy, err := StartProxy(router, slog.New(slog.NewTextHandler(log, nil)))
	if err != nil {
		t.Fatalf("start the proxy: %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close() })
	return proxy
}

// connect sends CONNECT to the proxy and returns the status line and the open connection.
func connect(t *testing.T, proxy *Proxy, target, credentials string) (string, net.Conn, *bufio.Reader) {
	t.Helper()
	connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", proxy.Port()), 5*time.Second)
	if err != nil {
		t.Fatalf("dial the proxy: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	request := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if credentials != "" {
		request += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(credentials)) + "\r\n"
	}
	if _, err := io.WriteString(connection, request+"\r\n"); err != nil {
		t.Fatalf("write CONNECT: %v", err)
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read the proxy's answer: %v", err)
	}
	return response.Status, connection, reader
}

func TestProxyTunnelsANameOfItsTailnet(t *testing.T) {
	upstream := echoServer(t)
	var dialed string
	proxy := startTestProxy(t, routeTo{
		domain: "example-org.lazurio.io",
		dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			dialed = address
			return (&net.Dialer{}).DialContext(ctx, network, upstream)
		},
	})

	status, connection, reader := connect(t, proxy, "launchpad.alice.example-org.lazurio.io:443", proxy.username+":"+proxy.password)
	if status != "200 Connection Established" {
		t.Fatalf("status = %q", status)
	}
	if _, err := io.WriteString(connection, "hello\n"); err != nil {
		t.Fatalf("write through the tunnel: %v", err)
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read through the tunnel: %v", err)
	}
	if line != "echo hello\n" || dialed != "launchpad.alice.example-org.lazurio.io:443" {
		t.Fatalf("line = %q, dialed = %q", line, dialed)
	}
}

func TestProxyRefusesWithoutItsCredentials(t *testing.T) {
	proxy := startTestProxy(t, routeTo{domain: "example-org.lazurio.io"})
	for _, credentials := range []string{"", "lazurio-app:wrong", "other:" + proxy.password} {
		status, _, _ := connect(t, proxy, "launchpad.example-org.lazurio.io:443", credentials)
		if status != "407 Proxy Authentication Required" {
			t.Fatalf("credentials %q: status = %q", credentials, status)
		}
	}
}

func TestProxyRefusesNamesNoTailnetServes(t *testing.T) {
	proxy := startTestProxy(t, routeTo{domain: "example-org.lazurio.io"})
	for _, target := range []string{"example.com:443", "example-org.lazurio.io.attacker.example:443", "evil-example-org.lazurio.io:443"} {
		status, _, _ := connect(t, proxy, target, proxy.username+":"+proxy.password)
		if status != "403 Forbidden" {
			t.Fatalf("target %q: status = %q", target, status)
		}
	}
}

func TestProxyAcceptsOnlyConnect(t *testing.T) {
	proxy := startTestProxy(t, routeTo{domain: "example-org.lazurio.io"})
	request, err := http.NewRequest(http.MethodGet, "http://launchpad.example-org.lazurio.io/", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(proxy.username+":"+proxy.password)))
	connection, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", proxy.Port()))
	if err != nil {
		t.Fatalf("dial the proxy: %v", err)
	}
	defer func() { _ = connection.Close() }()
	if err := request.WriteProxy(connection); err != nil {
		t.Fatalf("write the request: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), request)
	if err != nil {
		t.Fatalf("read the answer: %v", err)
	}
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", response.StatusCode)
	}
}

func TestProxyListensOnlyOnLoopback(t *testing.T) {
	proxy := startTestProxy(t, routeTo{domain: "example-org.lazurio.io"})
	address, ok := proxy.listener.Addr().(*net.TCPAddr)
	if !ok || !address.IP.IsLoopback() {
		t.Fatalf("listens on %v", proxy.listener.Addr())
	}
}

func TestProxyLogsAFailedDialWithoutAnyAddress(t *testing.T) {
	log := &lockedBuffer{}
	proxy := startLoggingTestProxy(t, routeTo{
		domain: "example-org.lazurio.io",
		dial: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("dial tcp 100.64.0.7:443 via [fd7a:115c:a1e0::7]:41641 to https://headscale.example-org.lazurio.io/x: connection refused")
		},
	}, log)

	status, _, _ := connect(t, proxy, "launchpad.alice.example-org.lazurio.io:443", proxy.username+":"+proxy.password)
	if status != "502 Bad Gateway" {
		t.Fatalf("status = %q", status)
	}
	line := log.String()
	if !strings.Contains(line, "the tailnet could not reach a name") ||
		!strings.Contains(line, "launchpad.alice.example-org.lazurio.io") ||
		!strings.Contains(line, "connection refused") {
		t.Fatalf("log = %q", line)
	}
	for _, address := range []string{"100.64.0.7", "fd7a:115c", "41641", "https://", "headscale."} {
		if strings.Contains(line, address) {
			t.Fatalf("log names %q: %q", address, line)
		}
	}
}
