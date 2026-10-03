package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsHostAccessSwitches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: \"gateway.example.com:9443\"\nconsole:\n  enabled: false\n  user: \"ops\"\nfiles:\n  enabled: false\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Console.IsEnabled() || cfg.Files.IsEnabled() {
		t.Fatalf("console and files must be disabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	if cfg.Console.User != "ops" {
		t.Fatalf("console.user = %q", cfg.Console.User)
	}
}

func TestLoadKeepsHostAccessEnabledByDefault(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("gateway:\n  address: \"gateway.example.com:9443\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Console.IsEnabled() || !cfg.Files.IsEnabled() {
		t.Fatalf("console and files must default to enabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
}
