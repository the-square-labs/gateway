package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadProvidesSupervisorIdentityPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`gateway:
  address: gateway.example.test:9443
worker:
  advertised_addresses:
    - relay.example.test
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.TLS.CACert == "" || cfg.TLS.ClientCert == "" || cfg.TLS.ClientKey == "" {
		t.Fatalf("supervisor TLS identity paths must be configured: %#v", cfg.TLS)
	}
	if cfg.TLS.CACert != "/var/lib/gateway-relay-supervisor/supervisor-identity/ca.pem" {
		t.Fatalf("unexpected supervisor CA path: %q", cfg.TLS.CACert)
	}
}
