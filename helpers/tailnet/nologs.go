package main

import (
	"sync"

	"tailscale.com/envknob"
	"tailscale.com/logtail"
)

// disableLogUploads keeps every node's log on the computer. By default tsnet uploads a node's
// log to log.tailscale.com (tsnet.Server.startLogger) with tsnet's own lines, which name the
// node's sign-in address, its peers and its control server, and which the helper's redaction
// never sees. Lazurio's tailnets run on their own control servers and send nothing to
// Tailscale's log server: no-logs-no-support makes the upload transport a no-op, and
// logtail.Disable drops the entries before they reach the log buffer.
var disableLogUploads = sync.OnceFunc(func() {
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
})
