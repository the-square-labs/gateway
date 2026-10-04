package lifecycle

import (
	"fmt"
	"strings"
)

// ExtraArgs refuses arguments after a command that takes none (run, version): "run version", used as a version
// check, started a second daemon with its own launcher.
func ExtraArgs(args []string) error {
	if len(args) <= 2 {
		return nil
	}
	return fmt.Errorf("unexpected arguments after %q: %s", args[1], strings.Join(args[2:], " "))
}
