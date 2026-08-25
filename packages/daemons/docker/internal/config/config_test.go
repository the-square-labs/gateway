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

func TestLoadComposeSidecarRequiresPinnedImageWhenConfigured(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "docker-daemon.yaml")
	base := "gateway:\n  address: https://gateway.example\n"
	if err := os.WriteFile(path, []byte(base+"docker:\n  compose:\n    sidecar_image: docker/compose:latest\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "sha256-pinned") {
		t.Fatalf("unpinned sidecar config error = %v", err)
	}
	pinned := "docker/compose@sha256:" + strings.Repeat("a", 64)
	if err := os.WriteFile(path, []byte(base+"docker:\n  compose:\n    sidecar_image: "+pinned+"\n"), 0o600); err != nil {
		t.Fatalf("write pinned config: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load pinned compose config: %v", err)
	}
	if loaded.Docker.Compose.CommandTimeoutSeconds != 15*60 {
		t.Fatalf("default compose timeout = %d", loaded.Docker.Compose.CommandTimeoutSeconds)
	}
}

func TestLoadDefaultsToPinnedComposeSidecar(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "docker-daemon.yaml")
	if err := os.WriteFile(path, []byte("gateway:\n  address: https://gateway.example\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load default compose config: %v", err)
	}
	if loaded.Docker.Compose.SidecarImage != DefaultComposeSidecarImage {
		t.Fatalf("default compose image = %q", loaded.Docker.Compose.SidecarImage)
	}
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
