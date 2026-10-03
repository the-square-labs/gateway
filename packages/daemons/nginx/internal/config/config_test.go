package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsHostIdentityPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	write := func(contents string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	write("gateway:\n  address: gw.example:9443\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HostIdentityPath != "" {
		t.Fatalf("default host identity path = %q, want empty (the shared default)", cfg.HostIdentityPath)
	}

	write("gateway:\n  address: gw.example:9443\nhost_identity_path: \"/var/lib/nginx-daemon/host-identity\"\n")
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HostIdentityPath != "/var/lib/nginx-daemon/host-identity" {
		t.Fatalf("host identity path = %q", cfg.HostIdentityPath)
	}
}
