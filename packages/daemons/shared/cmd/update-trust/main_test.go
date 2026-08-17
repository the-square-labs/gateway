package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

func TestRelayManifestIncludesBothConnectorImages(t *testing.T) {
	keyDir := filepath.Join(t.TempDir(), "keys")
	keygen([]string{"--out-dir", keyDir})
	encodedKey, err := os.ReadFile(filepath.Join(keyDir, "private.pem.b64"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("UPDATE_SIGNING_PRIVATE_KEY_PEM_B64", string(encodedKey))

	out := filepath.Join(t.TempDir(), "relay-image.update.json")
	digest := "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	databaseConnector := "registry.example/gateway/database-connector@" + digest
	secureLinkConnector := "registry.example/gateway/secure-link-connector@" + digest
	sign([]string{
		"--kind", "relay-image",
		"--version", "v1.2.3",
		"--tag", "v1.2.3-relay",
		"--image", "registry.example/gateway/relay",
		"--digest", digest,
		"--relay-protocol-major", "1",
		"--min-gateway-version", "v1.2.3",
		"--database-connector-image", databaseConnector,
		"--secure-link-connector-image", secureLinkConnector,
		"--out", out,
	})

	manifestBytes, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var envelope updateauth.Envelope
	if err := json.Unmarshal(manifestBytes, &envelope); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["databaseConnectorImage"] != databaseConnector {
		t.Fatalf("database connector image = %v, want %s", payload["databaseConnectorImage"], databaseConnector)
	}
	if payload["secureLinkConnectorImage"] != secureLinkConnector {
		t.Fatalf("secure-link connector image = %v, want %s", payload["secureLinkConnectorImage"], secureLinkConnector)
	}
}
