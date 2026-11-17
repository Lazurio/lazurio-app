package nodepolicy

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestIncomingConnectionsAreNeverAllowed(t *testing.T) {
	for _, choice := range []bool{true, false} {
		if IncomingAllowed(choice) {
			t.Fatalf("the policy allows incoming connections when the node's choice is %v", choice)
		}
	}
}

// The policy's effect on a node runs outside `go test`, where tailscale gives no node a policy
// client (testdata/restart).
func TestNodesStartWithShieldsUpAlsoAfterARestart(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs a program with three tsnet starts")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, filepath.Join(runtime.GOROOT(), "bin", "go"), "run", "./testdata/restart")
	output, err := command.CombinedOutput()
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if last := lines[len(lines)-1]; err != nil || last != "ok" {
		t.Fatalf("testdata/restart: %v\n%s", err, output)
	}
}
