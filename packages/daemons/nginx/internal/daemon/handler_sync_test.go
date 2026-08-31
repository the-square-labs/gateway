package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
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
