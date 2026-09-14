package docker

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

// Run only inside a disposable privileged Linux container: creation updates
// /etc/fstab and attaches a real loop device, just like the daemon does.
func TestVolumeImageCreationAllowsNonRootWrites(t *testing.T) {
	if os.Getenv("GATEWAY_TEST_VOLUME_IMAGES") != "1" {
		t.Skip("requires disposable privileged Linux container with ext4 tools")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create") {
			var request struct {
				Name       string
				Driver     string
				Labels     map[string]string
				DriverOpts map[string]string
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(volume.Volume{
				Name: request.Name, Driver: request.Driver, Scope: "local",
				Labels: request.Labels, Options: request.DriverOpts,
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"no such volume"}`))
	}))
	defer server.Close()
	dockerAPI, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	defer dockerAPI.Close()
	manager, err := newVolumeImageManager(t.TempDir(), &Client{cli: dockerAPI}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.create(t.Context(), "non-root-data", minimumVolumeImageBytes); err != nil {
		t.Fatal(err)
	}
	record, err := manager.loadRecord("non-root-data")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := manager.cleanupStorage(context.Background(), &record, true); err != nil {
			t.Error(err)
		}
	})
	// Bind the volume into an accessible path, as Docker does for the container.
	// The manager's private parent directories must remain inaccessible.
	target, err := os.MkdirTemp("/tmp", "volume-container-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(target) })
	run := func(name string, args ...string) {
		t.Helper()
		if output, err := exec.CommandContext(t.Context(), name, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v: %s", name, err, output)
		}
	}
	run("mount", "--bind", record.MountPath, target)
	t.Cleanup(func() {
		if output, err := exec.Command("umount", target).CombinedOutput(); err != nil {
			t.Errorf("unmount container path: %v: %s", err, output)
		}
	})
	write := exec.CommandContext(t.Context(), "/bin/sh", "-c", `mkdir "$1/app" && printf data > "$1/app/file" && mv "$1/app/file" "$1/app/renamed"`, "sh", target)
	write.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 10001, Gid: 10001}}
	if output, err := write.CombinedOutput(); err != nil {
		t.Fatalf("non-root volume write: %v: %s", err, output)
	}
	info, err := os.Stat(filepath.Join(target, "app", "renamed"))
	if err != nil || info.Sys().(*syscall.Stat_t).Uid != 10001 {
		t.Fatalf("application file must belong to UID 10001: %v", err)
	}
	for path, mode := range map[string]os.FileMode{
		record.MountPath: 0777, record.ImagePath: 0600,
		filepath.Dir(record.MountPath): 0700, filepath.Join(record.MountPath, "lost+found"): 0700,
	} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("unexpected permissions on %s, want %o: %v", path, mode, err)
		}
	}
	// A subsequent remount must preserve permissions deliberately set by the app.
	if err := os.Chmod(record.MountPath, 0750); err != nil {
		t.Fatal(err)
	}
	run("umount", target)
	run("umount", record.MountPath)
	if err := manager.ensureMounted(t.Context(), &record); err != nil {
		t.Fatal(err)
	}
	run("mount", "--bind", record.MountPath, target)
	info, err = os.Stat(record.MountPath)
	if err != nil || info.Mode().Perm() != 0750 {
		t.Fatalf("remount changed application permissions: %v", err)
	}
}
