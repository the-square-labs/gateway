package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func TestNginxConfigFingerprintTracksRelevantTrees(t *testing.T) {
	dir := t.TempDir()
	cfg := config.NginxConfig{
		GlobalConfig: filepath.Join(dir, "nginx.conf"),
		ConfigDir:    filepath.Join(dir, "conf.d"),
		CertsDir:     filepath.Join(dir, "certs"),
		HtpasswdDir:  filepath.Join(dir, "htpasswd"),
	}
	for _, path := range []string{cfg.ConfigDir, cfg.CertsDir, cfg.HtpasswdDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(cfg.GlobalConfig, []byte("events {}"), 0o600); err != nil {
		t.Fatal(err)
	}

	previous := currentNginxConfigSnapshot(cfg).fingerprint
	changes := []struct {
		name string
		path string
	}{
		{name: "global config", path: cfg.GlobalConfig},
		{name: "host config", path: filepath.Join(cfg.ConfigDir, "host.conf")},
		{name: "nested certificate", path: filepath.Join(cfg.CertsDir, "cert-1", "fullchain.pem")},
		{name: "htpasswd", path: filepath.Join(cfg.HtpasswdDir, "access-list-1")},
	}
	for index, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			if err := os.MkdirAll(filepath.Dir(change.path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(change.path, []byte(fmt.Sprintf("change-%d", index)), 0o600); err != nil {
				t.Fatal(err)
			}
			next := currentNginxConfigSnapshot(cfg).fingerprint
			if next == previous {
				t.Fatal("configuration fingerprint did not change")
			}
			previous = next
		})
	}
}

func TestNginxConfigFingerprintTracksOnlyActiveCertificateVersion(t *testing.T) {
	dir := t.TempDir()
	certsDir := filepath.Join(dir, "certs")
	certRoot := filepath.Join(certsDir, "cert-1")
	versionOne := filepath.Join(certRoot, "versions", "v1")
	versionTwo := filepath.Join(certRoot, "versions", "v2")
	for _, versionDir := range []string{versionOne, versionTwo} {
		if err := os.MkdirAll(versionDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"fullchain.pem", "privkey.pem"} {
			if err := os.WriteFile(filepath.Join(versionDir, name), []byte(versionDir), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.Symlink(filepath.Join("versions", "v1"), filepath.Join(certRoot, "current")); err != nil {
		t.Fatal(err)
	}
	cfg := config.NginxConfig{CertsDir: certsDir}
	baseline := currentNginxConfigSnapshot(cfg).fingerprint

	if err := os.WriteFile(filepath.Join(versionTwo, "fullchain.pem"), []byte("inactive update"), 0o600); err != nil {
		t.Fatal(err)
	}
	if next := currentNginxConfigSnapshot(cfg).fingerprint; next != baseline {
		t.Fatal("inactive immutable certificate version changed the fingerprint")
	}

	if err := os.Remove(filepath.Join(certRoot, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("versions", "v2"), filepath.Join(certRoot, "current")); err != nil {
		t.Fatal(err)
	}
	if next := currentNginxConfigSnapshot(cfg).fingerprint; next == baseline {
		t.Fatal("active certificate pointer change did not change the fingerprint")
	}
}

func TestFilesystemChangeRunsOneConfigTestAndRetainsInvalidFingerprint(t *testing.T) {
	plugin, argsPath, globalConfig := newConfigValidationTestPlugin(t)
	plugin.acceptConfigSnapshot(currentNginxConfigSnapshot(plugin.cfg.Nginx))
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(globalConfig, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !plugin.observeConfigChanges() {
		t.Fatal("expected changed config to be queued")
	}
	if plugin.validatePendingConfigChange() {
		t.Fatal("stable fingerprint unexpectedly requested another debounce")
	}
	if valid, _, checked := plugin.mgr.CachedConfigValidity(); !checked || valid {
		t.Fatalf("invalid changed config was not cached: valid=%v checked=%v", valid, checked)
	}
	if plugin.observeConfigChanges() {
		t.Fatal("unchanged invalid fingerprint was queued again")
	}
	plugin.validatePendingConfigChange()
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(args), "-t") != 1 {
		t.Fatalf("changed fingerprint was tested more than once: %q", args)
	}
}

func TestImmediateConfigTestAdvancesWatchedFingerprint(t *testing.T) {
	plugin, argsPath, globalConfig := newConfigValidationTestPlugin(t)
	plugin.acceptConfigSnapshot(currentNginxConfigSnapshot(plugin.cfg.Nginx))
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(globalConfig, []byte("gateway mutation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if valid, output := plugin.mgr.TestConfig(); !valid {
		t.Fatalf("immediate config test failed: %s", output)
	}
	if plugin.observeConfigChanges() {
		t.Fatal("immediately tested Gateway mutation was queued for duplicate validation")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(args), "-t") != 1 {
		t.Fatalf("expected only the immediate config test: %q", args)
	}
}

func TestDebouncedValidationSkipsAfterOverlappingImmediateTest(t *testing.T) {
	plugin, argsPath, globalConfig := newConfigValidationTestPlugin(t)
	dir := filepath.Dir(argsPath)
	blockPath := filepath.Join(dir, "block-config-test")
	startedPath := filepath.Join(dir, "config-test-started")
	plugin.acceptConfigSnapshot(currentNginxConfigSnapshot(plugin.cfg.Nginx))
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(globalConfig, []byte("gateway mutation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !plugin.observeConfigChanges() {
		t.Fatal("expected changed config to be pending")
	}
	if err := os.WriteFile(blockPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	immediateDone := make(chan struct{})
	go func() {
		defer close(immediateDone)
		plugin.mgr.TestConfig()
	}()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(startedPath); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := os.Stat(startedPath); err != nil {
		t.Fatal("immediate config test did not acquire the serialization lock")
	}

	watcherReady := make(chan struct{})
	watcherDone := make(chan bool, 1)
	go func() {
		watcherDone <- plugin.validatePendingConfigChangeWithHook(func() {
			close(watcherReady)
		})
	}()
	select {
	case <-watcherReady:
	case <-time.After(time.Second):
		t.Fatal("watcher did not reach the conditional config-test boundary")
	}
	if err := os.Remove(blockPath); err != nil {
		t.Fatal(err)
	}
	select {
	case <-immediateDone:
	case <-time.After(time.Second):
		t.Fatal("immediate config test did not finish")
	}
	select {
	case pending := <-watcherDone:
		if pending {
			t.Fatal("redundant watcher validation remained pending")
		}
	case <-time.After(time.Second):
		t.Fatal("watcher validation did not finish")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(args), "-t") != 1 {
		t.Fatalf("overlapping watcher ran a duplicate config test: %q", args)
	}
}

func TestPendingConfigValidationDebouncesFilesystemChanges(t *testing.T) {
	plugin, argsPath, globalConfig := newConfigValidationTestPlugin(t)
	plugin.acceptConfigSnapshot(currentNginxConfigSnapshot(plugin.cfg.Nginx))
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(globalConfig, []byte("candidate-1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !plugin.observeConfigChanges() {
		t.Fatal("first filesystem change was not queued")
	}
	if err := os.WriteFile(globalConfig, []byte("candidate-2"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !plugin.validatePendingConfigChange() {
		t.Fatal("new fingerprint should restart the debounce without running nginx -t")
	}
	if plugin.validatePendingConfigChange() {
		t.Fatal("stable fingerprint should complete validation without another debounce")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(args), "-t") != 1 {
		t.Fatalf("debounced change expected one config test: %q", args)
	}
}

func newConfigValidationTestPlugin(t *testing.T) (*NginxPlugin, string, string) {
	t.Helper()
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	globalConfig := filepath.Join(dir, "nginx.conf")
	binary := filepath.Join(dir, "nginx")
	script := fmt.Sprintf(
		"#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %q\nif [ -f %q ]; then touch %q; while [ -f %q ]; do sleep 0.01; done; fi\nif [ -f %q ] && [ \"$(cat %q)\" = invalid ]; then exit 1; fi\nexit 0\n",
		argsPath,
		filepath.Join(dir, "block-config-test"),
		filepath.Join(dir, "config-test-started"),
		filepath.Join(dir, "block-config-test"),
		globalConfig,
		globalConfig,
	)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dir, "conf.d"), filepath.Join(dir, "certs"), filepath.Join(dir, "htpasswd")} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(globalConfig, []byte("valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, GlobalConfig: globalConfig, ConfigDir: filepath.Join(dir, "conf.d"),
		CertsDir: filepath.Join(dir, "certs"), HtpasswdDir: filepath.Join(dir, "htpasswd"),
	}}
	mgr := nginx.NewManager(binary, cfg.Nginx.ConfigDir, cfg.Nginx.CertsDir, cfg.Nginx.GlobalConfig)
	if valid, _ := mgr.TestConfig(); !valid {
		t.Fatal("expected baseline config to be valid")
	}
	plugin := &NginxPlugin{
		cfg: cfg, mgr: mgr, logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mgr.SetConfigTestObserver(plugin.observeConfigTest)
	return plugin, argsPath, globalConfig
}
