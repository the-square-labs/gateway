package config

import (
	"fmt"
	"os"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"gopkg.in/yaml.v3"
)

// DockerConfig holds Docker-specific configuration.
type DockerConfig struct {
	Socket    string   `yaml:"socket"`
	Allowlist []string `yaml:"allowlist"`
	// Mode is empty for a general Docker node. "databases" makes the same
	// binary accept only the managed database lifecycle command.
	Mode     string         `yaml:"mode"`
	Database DatabaseConfig `yaml:"database"`
}

// DatabaseConfig is intentionally small: host storage is selected during
// installer preflight and all per-instance limits arrive through the dedicated
// protobuf command. A configured root may be an existing external volume.
type DatabaseConfig struct {
	StorageRoot  string `yaml:"storage_root"`
	ReserveBytes int64  `yaml:"reserve_bytes"`
}

// Config embeds the shared BaseConfig for the docker daemon.
type Config struct {
	lifecycle.BaseConfig `yaml:",inline"`
	Docker               DockerConfig `yaml:"docker"`
}

// Load reads and parses the docker daemon config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{}
	cfg.StateDir = "/var/lib/docker-daemon"
	cfg.LogLevel = "info"
	cfg.LogFormat = "json"
	cfg.Docker.Socket = "unix:///var/run/docker.sock"
	cfg.Docker.Allowlist = []string{"*"}
	cfg.Docker.Database.StorageRoot = "/var/lib/docker-daemon/databases"
	cfg.Docker.Database.ReserveBytes = 2 * 1024 * 1024 * 1024

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Gateway.Address == "" {
		return nil, fmt.Errorf("gateway.address is required")
	}
	if cfg.Docker.Mode != "" && cfg.Docker.Mode != "databases" {
		return nil, fmt.Errorf("docker.mode must be empty or databases")
	}
	if cfg.Docker.Mode == "databases" && cfg.Docker.Database.StorageRoot == "" {
		return nil, fmt.Errorf("docker.database.storage_root is required in databases mode")
	}

	return cfg, nil
}
