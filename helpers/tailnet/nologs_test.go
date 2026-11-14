package main

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"

	"tailscale.com/envknob"
	"tailscale.com/logtail"

	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

// recordingBuffer is a logtail buffer that keeps every line it is given for an upload.
type recordingBuffer struct {
	mu    sync.Mutex
	lines int
}

func (b *recordingBuffer) TryReadLine() ([]byte, error) { return nil, nil }

func (b *recordingBuffer) Write(line []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines++
	return len(line), nil
}

func (b *recordingBuffer) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lines
}

func TestNodesSendNoLogToTailscale(t *testing.T) {
	NewNodes(func(*tailnetv1.NodeState) {}, slog.Default())
	if !envknob.NoLogsNoSupport() {
		t.Fatal("no-logs-no-support is off, so tsnet would upload a node's log")
	}

	// A logger as tsnet makes one keeps nothing to upload.
	buffer := &recordingBuffer{}
	logger := logtail.NewLogger(logtail.Config{
		Collection: "tailnode.log.tailscale.io",
		Buffer:     buffer,
		Stderr:     io.Discard,
	}, t.Logf)
	t.Cleanup(func() { _ = logger.Shutdown(context.Background()) })
	logger.Logf("a line that names https://headscale.example-org.lazurio.io/register/abc")
	if lines := buffer.count(); lines != 0 {
		t.Fatalf("logtail kept %d lines to upload", lines)
	}
}
