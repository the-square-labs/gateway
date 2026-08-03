package main

import (
	"context"
	"fmt"
	"os"

	"github.com/wiolett-industries/gateway/installer/internal/cli"
)

// Version is set by the release pipeline.
var Version = "dev"

func main() {
	if err := cli.NewRootCommand(Version, os.Environ()).ExecuteContext(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
