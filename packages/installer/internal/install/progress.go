package install

import (
	"fmt"
	"io"
	"os"
)

const progressPrefix = "@@wiolett-step:"

// reportStep sends a machine-readable progress update to the bundled terminal
// UI. When the engine is run on its own, it remains a useful plain-text status.
func reportStep(output io.Writer, step string) {
	if os.Getenv("GATEWAY_INSTALLER_UI") == "1" {
		fmt.Fprintln(output, progressPrefix+step)
		return
	}
	fmt.Fprintln(output, step+"...")
}
