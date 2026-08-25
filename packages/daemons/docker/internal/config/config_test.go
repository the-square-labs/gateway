package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, dockerSection string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: gateway.example.com:9443\n" + dockerSection
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBuilderConfigOmitsDockerEngineAccess(t *testing.T) {
	cfg, err := Load(writeConfig(t, "docker:\n  mode: builder\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Docker.Socket != "" || len(cfg.Docker.Allowlist) != 0 {
		t.Fatalf("builder profile must not gain Docker access: %#v", cfg.Docker)
	}
}

func TestBuilderConfigRejectsDockerSocketOrAllowlist(t *testing.T) {
	for name, section := range map[string]string{
		"socket":    "docker:\n  mode: builder\n  socket: unix:///var/run/docker.sock\n",
		"allowlist": "docker:\n  mode: builder\n  allowlist: [\"*\"]\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Load(writeConfig(t, section))
			if err == nil || !strings.Contains(err.Error(), "builder mode") {
				t.Fatalf("expected builder isolation error, got %v", err)
			}
		})
	}
}

func TestGeneralDockerConfigRetainsLegacyDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, "docker: {}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Docker.Socket != "unix:///var/run/docker.sock" || len(cfg.Docker.Allowlist) != 1 || cfg.Docker.Allowlist[0] != "*" {
		t.Fatalf("unexpected general Docker defaults: %#v", cfg.Docker)
	}
}
