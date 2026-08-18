package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadNormalizesLegacyHtpasswdDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := []byte("gateway:\n  address: gateway.example:9443\nnginx:\n  binary: /usr/sbin/nginx\n  config_dir: /etc/nginx/http.d\n  certs_dir: /etc/nginx/certs\n  htpasswd_dir: /etc/nginx/htpasswd\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Nginx.HtpasswdDir != canonicalHtpasswdDir {
		t.Fatalf("HtpasswdDir = %q, want %q", cfg.Nginx.HtpasswdDir, canonicalHtpasswdDir)
	}
	if cfg.Nginx.PagesRoot != "/var/lib/nginx-daemon/pages" {
		t.Fatalf("PagesRoot = %q, want daemon-owned default", cfg.Nginx.PagesRoot)
	}
}

func TestLoadPreservesExplicitPagesRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := []byte("gateway:\n  address: gateway.example:9443\nnginx:\n  binary: /usr/sbin/nginx\n  config_dir: /etc/nginx/http.d\n  certs_dir: /etc/nginx/certs\n  pages_root: /srv/gateway-pages\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Nginx.PagesRoot != "/srv/gateway-pages" {
		t.Fatalf("PagesRoot = %q", cfg.Nginx.PagesRoot)
	}
}

func TestLoadPreservesExplicitNonLegacyHtpasswdDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := []byte("gateway:\n  address: gateway.example:9443\nnginx:\n  binary: /usr/sbin/nginx\n  config_dir: /etc/nginx/http.d\n  certs_dir: /etc/nginx/certs\n  htpasswd_dir: /srv/nginx/htpasswd\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Nginx.HtpasswdDir != "/srv/nginx/htpasswd" {
		t.Fatalf("HtpasswdDir = %q, want explicit custom path", cfg.Nginx.HtpasswdDir)
	}
}
