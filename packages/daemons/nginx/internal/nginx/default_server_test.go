package nginx

import (
	"os"
	"strings"
	"testing"
)

func TestEnsureDefaultServerWritesManagedFile(t *testing.T) {
	dir := t.TempDir()

	modified, err := EnsureDefaultServer(dir)
	if err != nil {
		t.Fatalf("ensure default server: %v", err)
	}
	if !modified {
		t.Fatal("expected the managed default server file to be created")
	}

	path := DefaultServerConfigPath(dir)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read managed default server file: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "listen 443 ssl default_server;") {
		t.Fatalf("expected IPv4 443 default_server directive, got:\n%s", content)
	}
	if !strings.Contains(content, "listen [::]:443 ssl default_server;") {
		t.Fatalf("expected IPv6 443 default_server directive, got:\n%s", content)
	}
	if !strings.Contains(content, "ssl_reject_handshake on;") {
		t.Fatalf("expected ssl_reject_handshake on, got:\n%s", content)
	}
	// This file must never declare a port-80 default_server: the installer's
	// default.conf already owns that (returning 404), and a second
	// default_server for the same address:port fails nginx -t.
	if strings.Contains(content, "listen 80") {
		t.Fatalf("managed default server must not touch port 80, got:\n%s", content)
	}
}

func TestEnsureDefaultServerIsIdempotent(t *testing.T) {
	dir := t.TempDir()

	if _, err := EnsureDefaultServer(dir); err != nil {
		t.Fatalf("first ensure default server: %v", err)
	}
	path := DefaultServerConfigPath(dir)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat managed default server file: %v", err)
	}
	firstModTime := info.ModTime()

	modified, err := EnsureDefaultServer(dir)
	if err != nil {
		t.Fatalf("second ensure default server: %v", err)
	}
	if modified {
		t.Fatal("expected the second call to be a no-op when content already matches")
	}

	info, err = os.Stat(path)
	if err != nil {
		t.Fatalf("stat managed default server file after no-op: %v", err)
	}
	if !info.ModTime().Equal(firstModTime) {
		t.Fatal("expected the file to be left untouched by a no-op call")
	}
}

func TestEnsureDefaultServerRepairsTamperedFile(t *testing.T) {
	dir := t.TempDir()

	if _, err := EnsureDefaultServer(dir); err != nil {
		t.Fatalf("initial ensure default server: %v", err)
	}
	path := DefaultServerConfigPath(dir)
	if err := os.WriteFile(path, []byte("# tampered\n"), 0o644); err != nil {
		t.Fatalf("tamper with managed default server file: %v", err)
	}

	modified, err := EnsureDefaultServer(dir)
	if err != nil {
		t.Fatalf("repair ensure default server: %v", err)
	}
	if !modified {
		t.Fatal("expected the tampered file to be repaired")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read repaired file: %v", err)
	}
	if !strings.Contains(string(data), "ssl_reject_handshake on;") {
		t.Fatalf("expected repaired content to restore ssl_reject_handshake, got:\n%s", data)
	}
}
