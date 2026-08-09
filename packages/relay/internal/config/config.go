package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Port        int
	AppTarget   string
	IdentityDir string
	StateDir    string
}

func Load() (Config, error) {
	port, err := positiveInt("RELAY_PORT", 9443)
	if err != nil {
		return Config{}, err
	}
	return Config{
		Port:        port,
		AppTarget:   value("RELAY_APP_GRPC_TARGET", "app:9443"),
		IdentityDir: filepath.Clean(value("RELAY_IDENTITY_DIR", "/var/lib/gateway-relay/identity")),
		StateDir:    filepath.Clean(value("RELAY_STATE_DIR", "/var/lib/gateway-relay/state")),
	}, nil
}

func value(name, fallback string) string {
	if current := os.Getenv(name); current != "" {
		return current
	}
	return fallback
}

func positiveInt(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 || parsed > 65535 {
		return 0, fmt.Errorf("%s must be an integer between 1 and 65535", name)
	}
	return parsed, nil
}
