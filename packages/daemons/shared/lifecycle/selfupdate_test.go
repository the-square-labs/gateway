package lifecycle

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestSelfUpdateRejectsMissingChecksum(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate("https://gitlab.wiolett.net/update", "v9.9.9", "", "manifest", "nginx", logger)
	if err == nil {
		t.Fatal("expected missing checksum to be rejected")
	}
}

func TestBackupBinaryPublishesExecutableCopy(t *testing.T) {
	source := filepath.Join(t.TempDir(), "daemon")
	backup := source + ".previous"
	if err := os.WriteFile(source, []byte("old-binary"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := BackupBinary(source, backup); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "old-binary" {
		t.Fatalf("backup contents = %q", contents)
	}
	info, err := os.Stat(backup)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0751 {
		t.Fatalf("backup mode = %o", info.Mode().Perm())
	}
}

func TestSelfUpdateRejectsMissingSignedManifest(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate(
		"https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64",
		"v9.9.9",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"",
		"nginx",
		logger,
	)
	if err == nil {
		t.Fatal("expected missing signed manifest to be rejected")
	}
}
