// Package nodepolicy is the system policy of every tailnet node of the helper: incoming
// connections never. A node's backend applies its policy to the preferences when it starts, before
// it restores a cached map or reaches its control server, so a node runs with shields up from its
// first packet filter on, also after a restart with the preferences tsnet gives it.
package nodepolicy

import (
	"sync"

	"tailscale.com/util/syspolicy/pkey"
	"tailscale.com/util/syspolicy/policyclient"
	"tailscale.com/util/syspolicy/ptype"
)

// client answers only the policy of incoming connections and leaves every other setting as the
// node would have it without a policy.
type client struct {
	policyclient.NoPolicyClient
}

func (client) GetPreferenceOption(key pkey.Key, defaultValue ptype.PreferenceOption) (ptype.PreferenceOption, error) {
	if key == pkey.EnableIncomingConnections {
		return ptype.NeverByPolicy, nil
	}
	return defaultValue, nil
}

// Install makes the policy every node's that starts afterwards. Inside `go test` tailscale gives
// every node a policy client that does nothing (testenv.InTest), so the policy's effect is tested
// in a program of its own (testdata/restart).
var Install = sync.OnceFunc(func() {
	policyclient.RegisterClientImpl(client{})
})

// IncomingAllowed reports what the policy decides for incoming connections, given the node's own
// choice.
func IncomingAllowed(choice bool) bool {
	option, _ := client{}.GetPreferenceOption(pkey.EnableIncomingConnections, ptype.ShowChoiceByPolicy)
	return option.ShouldEnable(choice)
}
