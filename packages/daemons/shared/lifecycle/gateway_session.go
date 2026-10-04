package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
)

// GatewaySessionFile, in the daemon state directory, records the last control
// session Gateway accepted. The installers remove it before they start the
// daemon and wait for it, so a daemon that runs but never reaches Gateway, or
// does not run at all, fails the install instead of passing it.
const GatewaySessionFile = "gateway-session.json"

type gatewaySessionRecord struct {
	PID         int    `json:"pid"`
	Version     string `json:"version"`
	ConnectedAt int64  `json:"connected_at"`
}

// recordGatewaySession notes that Gateway accepted this process's control
// session at the given time.
func recordGatewaySession(stateDir string, connectedAt time.Time) error {
	encoded, err := json.Marshal(gatewaySessionRecord{PID: os.Getpid(), Version: Version, ConnectedAt: connectedAt.Unix()})
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(stateDir, GatewaySessionFile), append(encoded, '\n'), 0o600)
}
