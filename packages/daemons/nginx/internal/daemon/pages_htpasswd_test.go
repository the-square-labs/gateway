package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	daemonconfig "github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
)

func TestRemoveHtpasswdKeepsCredentialsOfProtectedPreviews(t *testing.T) {
	dir := t.TempDir()
	htpasswdDir := filepath.Join(dir, "htpasswd")
	confDir := filepath.Join(dir, "conf")
	for _, path := range []string{htpasswdDir, confDir} {
		if err := os.MkdirAll(path, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	runtime, err := pages.New(filepath.Join(dir, "pages"), confDir, filepath.Join(dir, "certs"), pagesNginx{})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.SetHtpasswdDir(htpasswdDir); err != nil {
		t.Fatal(err)
	}
	const used = "44444444-4444-4444-8444-444444444444"
	const unused = "55555555-5555-4555-8555-555555555555"
	for _, id := range []string{used, unused} {
		if err := os.WriteFile(filepath.Join(htpasswdDir, "access-list-"+id), []byte("ops:hash\n"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	preview := "server {\n    auth_basic_user_file " + filepath.Join(htpasswdDir, "access-list-"+used) + ";\n}\n"
	if err := os.WriteFile(filepath.Join(confDir, "pages-preview-test.conf"), []byte(preview), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg := &daemonconfig.Config{}
	cfg.Nginx.HtpasswdDir = htpasswdDir
	handler := NewHandler(cfg, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, runtime, false)

	for _, id := range []string{used, unused} {
		result := &pb.CommandResult{Success: true}
		handler.handleRemoveHtpasswd(&pb.RemoveHtpasswdCommand{AccessListId: id}, result)
		if !result.Success {
			t.Fatalf("remove %s: %s", id, result.Error)
		}
	}
	if _, err := os.Stat(filepath.Join(htpasswdDir, "access-list-"+used)); err != nil {
		t.Fatalf("credentials of a protected preview were removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(htpasswdDir, "access-list-"+unused)); !os.IsNotExist(err) {
		t.Fatalf("unused credentials must still be removed: %v", err)
	}
}
