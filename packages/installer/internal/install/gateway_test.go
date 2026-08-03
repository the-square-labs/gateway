package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/installer/internal/config"
)

func TestWriteGatewayFilesForLocalStorage(t *testing.T) {
	dir := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	gateway := config.Gateway{Image: "example/gateway", Version: "v1.2.3", ResourceProfile: "medium", DatabaseMode: "local", LoggingMode: "local", OIDCClientID: "gateway", ClickHouseUsername: "gateway", ClickHouseDatabase: "gateway_logs", ClickHouseTable: "logs", LogMaxSize: "50m", LogMaxFile: "3", RestrictEnv: true}
	if err := writeGatewayEnv(gateway); err != nil {
		t.Fatal(err)
	}
	if err := writeGatewayCompose(gateway); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "DATABASE_URL=postgres://gateway:") {
		t.Fatalf("local database URL missing: %s", env)
	}
	compose, err := os.ReadFile(filepath.Join(dir, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"postgres:", "redis:", "clickhouse:", "GATEWAY_IMAGE_REF"} {
		if !strings.Contains(string(compose), expected) {
			t.Fatalf("compose missing %q", expected)
		}
	}
}

func TestValidateGatewayRemoteRequirements(t *testing.T) {
	gateway := config.Gateway{DatabaseMode: "remote", LoggingMode: "disabled", ResourceProfile: "medium"}
	if err := validateGateway(gateway); err == nil {
		t.Fatal("expected database URL error")
	}
}

func TestEnvFileValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("SETUP_TOKEN=test-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := envFileValue(path, "SETUP_TOKEN")
	if err != nil {
		t.Fatal(err)
	}
	if value != "test-token" {
		t.Fatalf("token = %q", value)
	}
}
