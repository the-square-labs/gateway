package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureServerNamesHashBucketSizeInjectsIntoHTTPBlock(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "nginx.conf")
	original := "events {}\nhttp {\n    server { listen 80; }\n}\n"
	if err := os.WriteFile(confPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	modified, err := EnsureServerNamesHashBucketSize(confPath)
	if err != nil {
		t.Fatalf("ensure server names hash bucket size: %v", err)
	}
	if !modified {
		t.Fatal("expected config to be modified")
	}

	data, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "Gateway Pages generated hostnames (auto-injected)") {
		t.Fatal("expected injected marker comment")
	}
	if strings.Count(content, "server_names_hash_bucket_size 128;") != 1 {
		t.Fatalf("expected bucket size to appear once, got %d", strings.Count(content, "server_names_hash_bucket_size 128;"))
	}
}

func TestEnsureServerNamesHashBucketSizeUpgradesLowerValue(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "nginx.conf")
	original := "events {}\nhttp {\n    server_names_hash_bucket_size 64;\n}\n"
	if err := os.WriteFile(confPath, []byte(original), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	modified, err := EnsureServerNamesHashBucketSize(confPath)
	if err != nil {
		t.Fatalf("ensure server names hash bucket size: %v", err)
	}
	if !modified {
		t.Fatal("expected config to be modified")
	}

	data, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(data), "server_names_hash_bucket_size 64;") || !strings.Contains(string(data), "server_names_hash_bucket_size 128;") {
		t.Fatalf("expected lower value to be upgraded, got:\n%s", data)
	}
}

func TestEnsureServerNamesHashBucketSizeNoopForSufficientValue(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "nginx.conf")
	existing := "events {}\nhttp {\n    server_names_hash_bucket_size 256;\n}\n"
	if err := os.WriteFile(confPath, []byte(existing), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	modified, err := EnsureServerNamesHashBucketSize(confPath)
	if err != nil {
		t.Fatalf("ensure server names hash bucket size: %v", err)
	}
	if modified {
		t.Fatal("expected config to remain unchanged")
	}

	data, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(data) != existing {
		t.Fatal("expected existing config content to remain unchanged")
	}
}
