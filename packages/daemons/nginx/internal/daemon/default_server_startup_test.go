package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

// newDefaultServerTestPlugin returns a plugin whose fake nginx rejects the configuration when the
// managed default server and the "operator-default" marker (an own 443 default_server) coexist,
// or when the "broken" marker exists.
func newDefaultServerTestPlugin(t *testing.T) (*NginxPlugin, string) {
	t.Helper()
	dir := t.TempDir()
	confDir := filepath.Join(dir, "conf.d")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "nginx")
	script := fmt.Sprintf(
		"#!/bin/sh\nif [ -f %q ]; then exit 1; fi\nif [ -f %q ] && [ -f %q ]; then exit 1; fi\nexit 0\n",
		filepath.Join(dir, "broken"),
		filepath.Join(dir, "operator-default"),
		nginx.DefaultServerConfigPath(confDir),
	)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, GlobalConfig: filepath.Join(dir, "nginx.conf"), ConfigDir: confDir,
		CertsDir: filepath.Join(dir, "certs"), HtpasswdDir: filepath.Join(dir, "htpasswd"),
	}}
	mgr := nginx.NewManager(binary, cfg.Nginx.ConfigDir, cfg.Nginx.CertsDir, cfg.Nginx.GlobalConfig)
	return &NginxPlugin{cfg: cfg, mgr: mgr, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, dir
}

func TestManagedDefaultServerIsWrittenWhenValid(t *testing.T) {
	plugin, _ := newDefaultServerTestPlugin(t)
	if !plugin.ensureManagedDefaultServer(plugin.logger) {
		t.Fatal("writing the default server should modify the config dir")
	}
	if _, err := os.Stat(nginx.DefaultServerConfigPath(plugin.cfg.Nginx.ConfigDir)); err != nil {
		t.Fatalf("default server missing: %v", err)
	}
	if plugin.ensureManagedDefaultServer(plugin.logger) {
		t.Fatal("an unchanged default server should not modify the config dir")
	}
}

func TestManagedDefaultServerBacksOutOfAConflictWithTheNodesOwnDefault(t *testing.T) {
	plugin, dir := newDefaultServerTestPlugin(t)
	if err := os.WriteFile(filepath.Join(dir, "operator-default"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if plugin.ensureManagedDefaultServer(plugin.logger) {
		t.Fatal("a conflicting default server must leave the config dir unchanged")
	}
	if _, err := os.Stat(nginx.DefaultServerConfigPath(plugin.cfg.Nginx.ConfigDir)); !os.IsNotExist(err) {
		t.Fatalf("conflicting default server should be removed, stat err = %v", err)
	}
	if valid, _ := plugin.mgr.TestConfig(); !valid {
		t.Fatal("the node's configuration must stay valid")
	}
}

func TestManagedDefaultServerStaysWhenTheConfigurationWasAlreadyInvalid(t *testing.T) {
	plugin, dir := newDefaultServerTestPlugin(t)
	if err := os.WriteFile(filepath.Join(dir, "broken"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !plugin.ensureManagedDefaultServer(plugin.logger) {
		t.Fatal("the default server should be kept when it is not the cause")
	}
	if _, err := os.Stat(nginx.DefaultServerConfigPath(plugin.cfg.Nginx.ConfigDir)); err != nil {
		t.Fatalf("default server missing: %v", err)
	}
}
