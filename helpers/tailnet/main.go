// Command lazurio-tailnet is the tailnet helper of Lazurio App. The app's main process starts it,
// and it speaks the helper protocol of proto/lazurio/app/helper/v1 over its standard input and
// output. Its log goes to standard error as JSON lines. The tailnet node itself (tsnet) comes with
// the first verification of the plan.
package main

import (
	"bufio"
	"log/slog"
	"os"
)

// version is set at build time with -ldflags "-X main.version=<version>".
var version = "0.0.0-dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := serve(bufio.NewReader(os.Stdin), os.Stdout, version); err != nil {
		logger.Error("helper stopped", "error", err)
		os.Exit(1)
	}
}
