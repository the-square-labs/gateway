package runtime

import (
	"os"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
)

// F-B6: the local Secure Runtime command of a daemon that runs as its own user pins the daemon's own version, so the
// installer never offers another release (the latest stable one can be older than a release candidate).
func TestLocalInstallCommandPinsTheDaemonVersion(t *testing.T) {
	previous := lifecycle.Version
	t.Cleanup(func() { lifecycle.Version = previous })

	lifecycle.Version = "v2.11.1-rc.20"
	command := localInstallCommand()
	if os.Geteuid() == 0 {
		if command != "sudo docker-daemon runtime install runsc" {
			t.Fatalf("root command = %q", command)
		}
		return
	}
	if !strings.HasPrefix(command, "sudo bash setup-docker-node.sh --user ") ||
		!strings.HasSuffix(command, " --secure-runtime --version v2.11.1-rc.20") {
		t.Fatalf("command = %q", command)
	}

	lifecycle.Version = "dev"
	if command := localInstallCommand(); !strings.HasSuffix(command, " --secure-runtime") {
		t.Fatalf("a development build names no version: %q", command)
	}
}
