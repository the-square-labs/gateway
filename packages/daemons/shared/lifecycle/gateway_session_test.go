package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The installers read this record to tell a daemon Gateway accepted in their
// run from one that runs but never connected.
func TestRecordGatewaySessionWritesTheInstallerRecord(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, GatewaySessionFile)
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	connectedAt := time.Unix(1_700_000_000, 0)
	if err := recordGatewaySession(stateDir, connectedAt); err != nil {
		t.Fatalf("record gateway session: %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record gatewaySessionRecord
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatalf("parse %q: %v", contents, err)
	}
	if record.PID != os.Getpid() || record.ConnectedAt != connectedAt.Unix() || record.Version != Version {
		t.Fatalf("record = %+v, want pid %d, connected_at %d, version %q", record, os.Getpid(), connectedAt.Unix(), Version)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
}
