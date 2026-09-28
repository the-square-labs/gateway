package daemon

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func TestApplyTlsBundleReportsAndLogsNginxTestOutput(t *testing.T) {
	const nginxError = "nginx: [emerg] could not build variables_hash, you should increase variables_hash_bucket_size: 64"
	checker := filepath.Join(t.TempDir(), "nginx-check")
	script := "#!/bin/sh\nif [ \"$1\" = \"-t\" ]; then echo '" + nginxError + "' >&2; exit 1; fi\nexit 0\n"
	if err := os.WriteFile(checker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(checker, configDir, t.TempDir(), "")
	var logs bytes.Buffer
	handler := &Handler{mgr: manager, logger: slog.New(slog.NewTextHandler(&logs, nil))}

	result := &pb.CommandResult{Success: true}
	handler.handleApplyTlsBundle(&pb.ApplyTlsBundleCommand{
		HostId:        testSecureLinkID,
		Generation:    strings.Repeat("a", 64),
		ConfigContent: "server { listen 443 ssl; }\n",
	}, result)

	if result.Success || !strings.Contains(result.Error, nginxError) {
		t.Fatalf("expected the nginx -t output in the error, got success=%v error=%q", result.Success, result.Error)
	}
	if !strings.Contains(logs.String(), "variables_hash_bucket_size") {
		t.Fatalf("nginx -t output was not logged: %s", logs.String())
	}
	if _, err := os.Stat(manager.ConfigPath(testSecureLinkID)); !os.IsNotExist(err) {
		t.Fatalf("rejected TLS config was not rolled back: %v", err)
	}
}
