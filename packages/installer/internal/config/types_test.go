package config

import "testing"

func TestNodeNormalizeUsesHostAndDefaultPort(t *testing.T) {
	node := Node{Host: "gateway.example.test"}
	if err := node.Normalize(); err != nil {
		t.Fatal(err)
	}
	if node.Gateway != "gateway.example.test:9443" {
		t.Fatalf("gateway = %q", node.Gateway)
	}
}

func TestDatabaseNodeRequiresStorageRootNonInteractive(t *testing.T) {
	node := Node{Type: NodeDatabases, Gateway: "gateway:9443", Token: "token", GatewayCertSHA256: "sha256:test"}
	if err := node.ValidateEnrollment(); err == nil {
		t.Fatal("expected storage-root error")
	}
}

func TestGatewayDefaults(t *testing.T) {
	gateway := Gateway{}
	gateway.Normalize()
	if gateway.ResourceProfile != "medium" || gateway.LoggingMode != "local" || gateway.DatabaseMode != "local" {
		t.Fatalf("unexpected defaults: %#v", gateway)
	}
}
