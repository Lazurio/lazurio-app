// Command lazurio-tailnet is the tailnet helper of Lazurio App. The app's main process starts it,
// and it speaks the helper protocol of proto/lazurio/app/helper/v1 over its standard input and
// output. It holds one tsnet node for each tailnet the person belongs to and a local proxy through
// which only the app's own views reach them (decision 0248). Its log goes to standard error as
// JSON lines.
package main

import (
	"bufio"
	"log/slog"
	"os"

	helperv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/helper/v1"
	tailnetv1 "github.com/Lazurio/lazurio-app/helpers/tailnet/gen/lazurio/app/tailnet/v1"
)

// version is set at build time with -ldflags "-X main.version=<version>".
var version = "0.0.0-dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := checkBuild(missingOmissions()); err != nil {
		logger.Error("helper stopped", "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "read-policy" {
		os.Exit(readPolicyCommand(readPolicy, os.Stdout, os.Stderr))
	}
	if len(os.Args) == 2 && os.Args[1] == "read-user-setting" {
		os.Exit(readPolicyCommand(readUserSetting, os.Stdout, os.Stderr))
	}
	out := NewOutbox(os.Stdout)
	nodes := NewNodes(func(state *tailnetv1.NodeState) {
		if err := out.Send(&helperv1.HelperMessage{
			Kind: &helperv1.HelperMessage_NodeState{NodeState: state},
		}); err != nil {
			logger.Error("cannot report a node's state", "error", err)
		}
	}, logger)
	proxy, err := StartProxy(nodes, logger)
	if err != nil {
		logger.Error("helper stopped", "error", err)
		os.Exit(1)
	}
	endpoint := &tailnetv1.ProxyEndpoint{
		Host:     "127.0.0.1",
		Port:     proxy.Port(),
		Username: proxy.username,
		Password: proxy.password,
	}
	err = serve(bufio.NewReader(os.Stdin), out, version, nodes, endpoint)
	nodes.Close()
	_ = proxy.Close()
	if err != nil {
		logger.Error("helper stopped", "error", err)
		os.Exit(1)
	}
}
