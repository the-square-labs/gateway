package lifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

// SelfUpdate downloads a new binary from downloadURL, verifies its checksum,
// replaces the current binary, and triggers a restart via systemd.
func SelfUpdate(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType string, logger *slog.Logger) error {
	execPath, err := os.Executable()
	if err != nil {
		logger.Error("self-update failed to resolve executable path", "error", err)
		return fmt.Errorf("resolve executable path: %w", err)
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		logger.Error("self-update failed to resolve executable symlink", "error", err)
		return fmt.Errorf("resolve symlinks: %w", err)
	}
	if daemonType != "relay" {
		return ReplaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, execPath, logger)
	}
	backupPath := execPath + ".previous"
	if err := BackupBinary(execPath, backupPath); err != nil {
		return fmt.Errorf("backup current relay supervisor: %w", err)
	}
	if err := ReplaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, execPath, logger); err != nil {
		_ = os.Remove(backupPath)
		return err
	}
	if err := os.WriteFile(execPath+".update-pending", []byte(targetVersion+"\n"), 0600); err != nil {
		if restoreErr := os.Rename(backupPath, execPath); restoreErr != nil {
			return fmt.Errorf("write relay supervisor update marker: %v; rollback failed: %w", err, restoreErr)
		}
		return fmt.Errorf("write relay supervisor update marker: %w", err)
	}
	return nil
}

// BackupBinary creates an fsync'd same-filesystem copy and publishes it with
// an atomic rename so an external supervisor can safely roll back an update.
func BackupBinary(source, destination string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".daemon-backup-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, src); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(info.Mode().Perm()); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, destination)
}

// ReplaceBinaryAtPath downloads and verifies a signed daemon artifact before
// atomically replacing destination. Process restart and health verification are
// deliberately left to the caller.
func ReplaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, destination string, logger *slog.Logger) error {
	logger.Info("starting self-update",
		"target_version", targetVersion,
		"download_url", downloadURL,
		"arch", runtime.GOARCH,
	)

	expectedChecksum = strings.ToLower(strings.TrimSpace(expectedChecksum))
	if expectedChecksum == "" {
		logger.Error("self-update rejected missing checksum")
		return fmt.Errorf("missing update checksum")
	}
	if signedManifest == "" {
		logger.Error("self-update rejected missing signed manifest")
		return fmt.Errorf("missing signed update manifest")
	}
	updateURL, err := url.Parse(downloadURL)
	if err != nil {
		logger.Error("self-update rejected invalid download URL", "error", err)
		return fmt.Errorf("parse update download URL: %w", err)
	}
	artifactName := path.Base(updateURL.Path)
	tag := path.Base(path.Dir(updateURL.Path))
	if _, err := updateauth.VerifyDaemonManifest(signedManifest, updateauth.DaemonExpectation{
		DaemonType:   daemonType,
		Version:      targetVersion,
		Tag:          tag,
		Arch:         updateauth.NormalizeArch(runtime.GOARCH),
		ArtifactName: artifactName,
		DownloadURL:  downloadURL,
		SHA256:       expectedChecksum,
	}); err != nil {
		logger.Error("self-update rejected untrusted manifest", "error", err)
		return fmt.Errorf("verify signed update manifest: %w", err)
	}

	// Download to temp file in the same directory (for atomic rename)
	tmpFile, err := os.CreateTemp(filepath.Dir(destination), ".daemon-update-*")
	if err != nil {
		logger.Error("self-update failed to create temp file", "error", err)
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		tmpFile.Close()
		os.Remove(tmpPath) // cleanup on failure; on success we already renamed
	}()

	// Download binary
	client := &http.Client{Timeout: 5 * time.Minute}
	logger.Info("downloading daemon update", "target_version", targetVersion)
	resp, err := client.Get(downloadURL)
	if err != nil {
		logger.Error("self-update download failed", "error", err)
		return fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		logger.Error("self-update download returned unexpected status", "status", resp.StatusCode)
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	// Write + compute checksum simultaneously
	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)
	if _, err := io.Copy(writer, resp.Body); err != nil {
		logger.Error("self-update failed while writing downloaded binary", "error", err)
		return fmt.Errorf("write binary: %w", err)
	}
	tmpFile.Close()
	logger.Info("daemon update downloaded", "target_version", targetVersion)

	// Verify checksum
	actualChecksum := hex.EncodeToString(hasher.Sum(nil))
	if actualChecksum != expectedChecksum {
		logger.Error("self-update checksum mismatch", "expected", expectedChecksum, "actual", actualChecksum)
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}
	logger.Info("self-update checksum verified", "checksum", actualChecksum)

	// Make executable
	if err := os.Chmod(tmpPath, 0755); err != nil {
		logger.Error("self-update failed to chmod new binary", "error", err)
		return fmt.Errorf("chmod: %w", err)
	}

	// Atomic replace: rename temp file over the current binary
	if err := os.Rename(tmpPath, destination); err != nil {
		logger.Error("self-update failed to replace binary", "error", err, "path", destination)
		return fmt.Errorf("replace binary: %w", err)
	}

	logger.Info("binary replaced successfully",
		"target_version", targetVersion,
		"path", destination,
	)

	return nil
}
