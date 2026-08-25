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
	// Mode is empty for a general Docker node. "databases" and "builder"
	// turn the same binary into mutually exclusive, least-privilege profiles.
	Mode     string         `yaml:"mode"`
	Database DatabaseConfig `yaml:"database"`
	Builder  BuilderConfig  `yaml:"builder"`
}

type BuilderConfig struct {
	EgressProfile string `yaml:"egress_profile"`
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
	cfg.Docker.Database.StorageRoot = "/var/lib/docker-daemon/databases"
	cfg.Docker.Database.ReserveBytes = 2 * 1024 * 1024 * 1024
	cfg.Docker.Builder.EgressProfile = "internet"

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Gateway.Address == "" {
		return nil, fmt.Errorf("gateway.address is required")
	}
	if cfg.Docker.Mode != "" && cfg.Docker.Mode != "databases" && cfg.Docker.Mode != "builder" {
		return nil, fmt.Errorf("docker.mode must be empty, databases, or builder")
	}
	if cfg.Docker.Mode == "databases" && cfg.Docker.Database.StorageRoot == "" {
		return nil, fmt.Errorf("docker.database.storage_root is required in databases mode")
	}
	if cfg.Docker.Mode == "builder" {
		if cfg.Docker.Socket != "" {
			return nil, fmt.Errorf("docker.socket must be omitted in builder mode")
		}
		if len(cfg.Docker.Allowlist) != 0 {
			return nil, fmt.Errorf("docker.allowlist must be empty in builder mode")
		}
		if cfg.Docker.Builder.EgressProfile != "internet" && cfg.Docker.Builder.EgressProfile != "offline" {
			return nil, fmt.Errorf("docker.builder.egress_profile must be internet or offline")
		}
	} else {
		if cfg.Docker.Socket == "" {
			cfg.Docker.Socket = "unix:///var/run/docker.sock"
		}
		if len(cfg.Docker.Allowlist) == 0 {
			cfg.Docker.Allowlist = []string{"*"}
		}
	}

	return cfg, nil
}
