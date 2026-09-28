package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	sharedstate "github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func TestFullSyncRestoresGlobalConfigAfterFailedValidation(t *testing.T) {
	tests := []struct {
		name     string
		original *string
	}{
		{name: "existing file", original: stringPointer("original")},
		{name: "new file", original: nil},
		{name: "existing empty file", original: stringPointer("")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			configDir := filepath.Join(dir, "conf.d")
			globalConfig := filepath.Join(dir, "nginx.conf")
			if err := os.MkdirAll(configDir, 0o755); err != nil {
				t.Fatal(err)
			}
			if tt.original != nil {
				if err := os.WriteFile(globalConfig, []byte(*tt.original), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			binary := filepath.Join(dir, "nginx")
			script := fmt.Sprintf("#!/bin/sh\nif [ -f %q ] && [ \"$(cat %q)\" = candidate ]; then exit 1; fi\nexit 0\n", globalConfig, globalConfig)
			if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}

			cfg := &config.Config{Nginx: config.NginxConfig{
				Binary: binary, ConfigDir: configDir, CertsDir: filepath.Join(dir, "certs"),
				HtpasswdDir: filepath.Join(dir, "htpasswd"), GlobalConfig: globalConfig,
			}}
			mgr := nginx.NewManager(binary, configDir, cfg.Nginx.CertsDir, globalConfig)
			handler := &Handler{cfg: cfg, mgr: mgr, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			result := &pb.CommandResult{Success: true}

			handler.handleFullSync(&pb.FullSyncCommand{GlobalConfig: "candidate"}, result)

			if result.Success {
				t.Fatal("expected FullSync validation failure")
			}
			content, err := os.ReadFile(globalConfig)
			if tt.original == nil {
				if !os.IsNotExist(err) {
					t.Fatalf("new global config was not removed: content=%q err=%v", content, err)
				}
			} else if err != nil || string(content) != *tt.original {
				t.Fatalf("global config was not restored: content=%q err=%v", content, err)
			}
			if valid, _, checked := mgr.CachedConfigValidity(); !checked || !valid {
				t.Fatalf("restored validity was not cached: valid=%v checked=%v", valid, checked)
			}
		})
	}
}

func TestUpdateGlobalConfigRestoresPreviousStateAfterFailure(t *testing.T) {
	tests := []struct {
		name        string
		original    *string
		failureMode string
	}{
		{name: "validation failure restores existing file", original: stringPointer("original"), failureMode: "validation"},
		{name: "validation failure removes new file", original: nil, failureMode: "validation"},
		{name: "validation failure restores empty file", original: stringPointer(""), failureMode: "validation"},
		{name: "reload failure restores existing file", original: stringPointer("original"), failureMode: "reload"},
		{name: "reload failure removes new file", original: nil, failureMode: "reload"},
		{name: "reload failure restores empty file", original: stringPointer(""), failureMode: "reload"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			configDir := filepath.Join(dir, "conf.d")
			globalConfig := filepath.Join(dir, "nginx.conf")
			if err := os.MkdirAll(configDir, 0o755); err != nil {
				t.Fatal(err)
			}
			if tt.original != nil {
				if err := os.WriteFile(globalConfig, []byte(*tt.original), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			binary := filepath.Join(dir, "nginx")
			var script string
			if tt.failureMode == "validation" {
				script = fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = -t ] && [ -f %q ] && [ \"$(cat %q)\" = candidate ]; then exit 1; fi\nexit 0\n", globalConfig, globalConfig)
			} else {
				script = "#!/bin/sh\nif [ \"$1\" = -s ] && [ \"$2\" = reload ]; then exit 1; fi\nexit 0\n"
			}
			if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}

			cfg := &config.Config{Nginx: config.NginxConfig{
				Binary: binary, ConfigDir: configDir, CertsDir: filepath.Join(dir, "certs"),
				HtpasswdDir: filepath.Join(dir, "htpasswd"), GlobalConfig: globalConfig,
			}}
			mgr := nginx.NewManager(binary, configDir, cfg.Nginx.CertsDir, globalConfig)
			handler := &Handler{cfg: cfg, mgr: mgr, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			result := &pb.CommandResult{Success: true}

			handler.handleUpdateGlobalConfig(&pb.UpdateGlobalConfigCommand{Content: "candidate"}, result)

			if result.Success {
				t.Fatalf("expected %s failure", tt.failureMode)
			}
			content, err := os.ReadFile(globalConfig)
			if tt.original == nil {
				if !os.IsNotExist(err) {
					t.Fatalf("new global config was not removed: content=%q err=%v", content, err)
				}
			} else if err != nil || string(content) != *tt.original {
				t.Fatalf("global config was not restored: content=%q err=%v", content, err)
			}
			if valid, _, checked := mgr.CachedConfigValidity(); !checked || !valid {
				t.Fatalf("restored validity was not cached: valid=%v checked=%v", valid, checked)
			}
		})
	}
}

func stringPointer(value string) *string { return &value }

func TestFullSyncRemovesTheCacheOfRemovedHostsOnly(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, "conf.d")
	cacheRoot := filepath.Join(dir, "tmp")
	previousRoot := hostCacheRoot
	hostCacheRoot = cacheRoot
	t.Cleanup(func() { hostCacheRoot = previousRoot })
	for _, path := range []string{configDir, filepath.Join(cacheRoot, "nginx-cache-kept", "a"), filepath.Join(cacheRoot, "nginx-cache-removed", "b")} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"proxy-host-kept.conf", "proxy-host-removed.conf"} {
		if err := os.WriteFile(filepath.Join(configDir, name), []byte("# host"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	binary := filepath.Join(dir, "nginx")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := sharedstate.Load(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	globalConfig := filepath.Join(dir, "nginx.conf")
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, ConfigDir: configDir, CertsDir: filepath.Join(dir, "certs"),
		HtpasswdDir: filepath.Join(dir, "htpasswd"), GlobalConfig: globalConfig,
	}}
	mgr := nginx.NewManager(binary, configDir, cfg.Nginx.CertsDir, globalConfig)
	handler := &Handler{cfg: cfg, mgr: mgr, state: st, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	result := &pb.CommandResult{Success: true}

	handler.handleFullSync(&pb.FullSyncCommand{Hosts: []*pb.HostConfig{{HostId: "kept", ConfigContent: "# kept"}}}, result)

	if !result.Success {
		t.Fatalf("full sync failed: %s", result.Error)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "nginx-cache-removed")); !os.IsNotExist(err) {
		t.Fatalf("cache of the removed host survived: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "nginx-cache-kept", "a")); err != nil {
		t.Fatalf("cache of the kept host was removed: %v", err)
	}
}

func TestHostCacheDirRefusesAnythingButAHostID(t *testing.T) {
	for _, id := range []string{"", "../etc", "a/b", "x y", "id;"} {
		if dir := hostCacheDir(id); dir != "" {
			t.Fatalf("hostCacheDir(%q) = %q, want none", id, dir)
		}
	}
	if dir := hostCacheDir("44444444-4444-4444-8444-444444444444"); dir != filepath.Join(hostCacheRoot, "nginx-cache-44444444-4444-4444-8444-444444444444") {
		t.Fatalf("unexpected cache dir %q", dir)
	}
}
