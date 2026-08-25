package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
