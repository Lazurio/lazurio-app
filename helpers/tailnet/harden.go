package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"tailscale.com/envknob"
	"tailscale.com/feature/buildfeatures"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

// The build tags `pnpm build:helpers` gives every build of this helper (scripts/lib/helper-build.ts).
// They leave out of the binary what an app node never needs and an IT department would have to
// assess: the control server's requests for debug data (c2n), network flow logs (netlog) and the
// node's own API for its peers (peerapi). A node without peerapi listens on nothing in its tailnet.
var omittedFeatures = []struct {
	tag     string
	present bool
}{
	{"ts_omit_c2n", buildfeatures.HasC2N},
	{"ts_omit_netlog", buildfeatures.HasNetLog},
	{"ts_omit_peerapiserver", buildfeatures.HasPeerAPIServer},
}

// missingOmissions names the build tags this binary was built without.
func missingOmissions() []string {
	var missing []string
	for _, feature := range omittedFeatures {
		if feature.present {
			missing = append(missing, feature.tag)
		}
	}
	return missing
}

// checkBuild refuses a binary built without the tags, so no such build runs a node.
func checkBuild(missing []string) error {
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("built without %s; build with `pnpm build:helpers`", strings.Join(missing, ","))
}

// disableRouterPortMapping keeps every node from asking the network's router to open a port for it
// (UPnP, NAT-PMP, PCP). A node still reaches its peers directly where the network lets it, and
// through a DERP relay over HTTPS where it does not.
var disableRouterPortMapping = sync.OnceFunc(func() {
	envknob.Setenv("TS_DISABLE_PORTMAPPER", "true")
})

// shieldsUp makes the node refuse every connection its tailnet opens to it, while its own
// connections to the Environments work as before. tsnet starts each node with its own preferences,
// which leave shields up off, so the helper turns it on again after every start; until the node has
// its first map from the control server it accepts nothing anyway.
func shieldsUp(ctx context.Context, server *tsnet.Server) error {
	client, err := server.LocalClient()
	if err != nil {
		return fmt.Errorf("no local client for the node: %w", err)
	}
	prefs, err := client.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs:        ipn.Prefs{ShieldsUp: true},
		ShieldsUpSet: true,
	})
	if err != nil {
		return fmt.Errorf("turn on shields up: %w", err)
	}
	if !prefs.ShieldsUp {
		return errors.New("the node kept shields up off")
	}
	return nil
}
