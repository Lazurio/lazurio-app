// The proof adds this one file to helpers/tailnet through `go build -overlay`, without changing the
// helper itself.
//
// Android denies apps netlink and /proc/net, so net.Interfaces fails and a node cannot start
// (golang/go#40569). Tailscale's androidbin feature falls back to an interface it discovers by
// routing a UDP socket, and finds Android's system CA store and DNS servers. It registers only in
// static GOOS=linux builds (and GOOS=android builds without cgo), so the proof builds the helper
// as a static Linux binary, which Android's kernel runs as it is.
//
// A Linux build also binds its control and DERP dials to the default route's interface, which it
// looks up over netlink as well; on Android the app's own sockets need no such binding, so the
// proof turns it off.
//
// androiddns hooks only Go's default resolver, while the control client resolves its server through
// dnscache's own resolver, which on Android finds no resolv.conf and falls back to Tailscale's
// bootstrap DNS. The proof points dnscache at the default resolver.
//
// A real app would instead tell the helper its networks through the helper protocol, as
// Tailscale's own Android app does with netmon.RegisterInterfaceGetter.

package main

import (
	"net"

	_ "tailscale.com/feature/androidbin"
	"tailscale.com/net/dnscache"
	"tailscale.com/net/netns"
)

func init() {
	netns.SetEnabled(false)
	dnscache.Get().Forward = net.DefaultResolver
}
