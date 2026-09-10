//go:build linux

package nginx

import (
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Run only in the disposable Alpine container created by
// scripts/test-nginx-openrc.sh. Never enable this on a managed host.
func TestOpenRCPIDDirectoryLifecycle(t *testing.T) {
	if os.Getenv("GATEWAY_OPENRC_CONTAINER_TEST") != "1" {
		t.Skip("requires disposable Alpine/OpenRC container")
	}
	if os.Geteuid() != 0 {
		t.Fatal("container must run as root")
	}
	run := func(name string, args ...string) {
		t.Helper()
		output, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, output)
		}
	}
	const pidFile = "/run/nginx/nginx.pid"
	const directory = "/run/nginx"
	manager := NewManager("/usr/sbin/nginx", "/etc/nginx/http.d", "/tmp", "/etc/nginx/nginx.conf")
	assertSecured := func() {
		t.Helper()
		var stat unix.Stat_t
		if err := unix.Lstat(directory, &stat); err != nil {
			t.Fatal(err)
		}
		if stat.Uid != 0 || stat.Gid != 0 || stat.Mode&0o777 != 0o755 {
			t.Fatalf("PID directory not secured: uid=%d gid=%d mode=%o", stat.Uid, stat.Gid, stat.Mode&0o777)
		}
	}
	assertServing := func() {
		t.Helper()
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:18080/")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 || string(body) != "openrc-ok\n" {
			t.Fatalf("nginx response: status=%d body=%q err=%v", response.StatusCode, body, err)
		}
	}
	run("rc-service", "nginx", "start")
	t.Cleanup(func() { _ = exec.Command("rc-service", "nginx", "stop").Run() })
	// Reproduce the exact pre-upgrade permissions. The unchanged strict reader
	// rejects this state; binary-only startup must migrate it without an installer.
	run("chmod", "775", directory)
	if _, err := readTrustedPIDFile(pidFile); err == nil {
		t.Fatal("stock OpenRC directory unexpectedly passed strict validation")
	}
	pid, err := manager.GetPID()
	if err != nil {
		t.Fatalf("binary-only upgrade failed: %v", err)
	}
	assertSecured()
	assertServing()

	// Stock reload calls start_pre again and restores nginx ownership.
	run("rc-service", "nginx", "reload")
	if _, err := readTrustedPIDFile(pidFile); err == nil {
		t.Fatal("stock reload did not reproduce incompatible directory ownership")
	}
	if got, err := manager.GetPID(); err != nil || got != pid {
		t.Fatalf("reload should recover without restarting nginx: pid=%d err=%v", got, err)
	}
	assertSecured()
	assertServing()
	run("rc-service", "nginx", "restart")
	if _, err := manager.GetPID(); err != nil {
		t.Fatalf("restart migration failed: %v", err)
	}
	assertSecured()
	assertServing()

	// Execute the actual installer helper against the actual packaged service.
	installer, err := os.ReadFile("/workspace/scripts/setup-node.sh")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(installer), "ensure_nginx_openrc_pid_directory() {")
	end := strings.Index(string(installer), "ensure_nginx_service_limit() {")
	if start < 0 || end <= start {
		t.Fatal("installer migration helper missing")
	}
	helper := "set -euo pipefail\nhas_openrc() { return 0; }\nbackup_if_exists() { cp -p \"$1\" /tmp/nginx.init.backup; }\nlog() { :; }\ndie() { echo \"$*\" >&2; exit 1; }\n" + string(installer[start:end]) + "\nensure_nginx_openrc_pid_directory\n"
	run("bash", "-c", helper)
	updated, err := os.ReadFile("/etc/init.d/nginx")
	if err != nil {
		t.Fatal(err)
	}
	run("bash", "-c", helper)
	again, _ := os.ReadFile("/etc/init.d/nginx")
	if string(again) != string(updated) {
		t.Fatal("installer migration is not idempotent")
	}
	run("rc-service", "nginx", "reload")
	assertSecured()
	run("rc-service", "nginx", "stop")
	run("rmdir", directory)
	run("rc-service", "nginx", "start")
	assertSecured()
	if _, err := manager.GetPID(); err != nil {
		t.Fatalf("installed service recreated incompatible PID directory: %v", err)
	}
	assertServing()
	run("rc-service", "nginx", "stop")

	// Migration must never turn an attacker-controlled file or link into a
	// trusted PID. These cases run only after the real nginx process is stopped.
	t.Run("rejects untrusted PID file", func(t *testing.T) {
		if err := os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(pidFile)
		run("chown", "nginx:nginx", directory, pidFile)
		if err := prepareOpenRCPIDDirectory(pidFile); err != nil {
			t.Fatal(err)
		}
		if _, err := readTrustedPIDFile(pidFile); err == nil {
			t.Fatal("untrusted file became trusted")
		}
	})
	t.Run("rejects PID hard link", func(t *testing.T) {
		target := "/run/gateway-openrc-pid-test"
		if err := os.WriteFile(target, []byte("1"), 0o644); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(target)
		if err := os.Link(target, pidFile); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(pidFile)
		if _, err := readTrustedPIDFile(pidFile); err == nil {
			t.Fatal("hard-linked PID accepted")
		}
	})
	t.Run("rejects PID symlink", func(t *testing.T) {
		target := "/run/gateway-openrc-pid-test"
		if err := os.WriteFile(target, []byte("1"), 0o644); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(target)
		if err := os.Symlink(target, pidFile); err != nil {
			t.Fatal(err)
		}
		defer os.Remove(pidFile)
		if _, err := readTrustedPIDFile(pidFile); err == nil {
			t.Fatal("symlink PID accepted")
		}
	})
	t.Run("rejects world-writable directory", func(t *testing.T) {
		if err := os.Chmod(directory, 0o777); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(directory, 0o755)
		if err := prepareOpenRCPIDDirectory(pidFile); err == nil {
			t.Fatal("world-writable directory accepted")
		}
		info, _ := os.Stat(directory)
		if info.Mode().Perm() != 0o777 {
			t.Fatal("rejected directory was modified")
		}
	})
	t.Run("rejects unrelated directory owner", func(t *testing.T) {
		if err := os.Chown(directory, 45678, 45678); err != nil {
			t.Fatal(err)
		}
		defer os.Chown(directory, 0, 0)
		if err := prepareOpenRCPIDDirectory(pidFile); err == nil {
			t.Fatal("unrelated directory owner accepted")
		}
		var stat unix.Stat_t
		if err := unix.Lstat(directory, &stat); err != nil || stat.Uid != 45678 {
			t.Fatal("rejected directory owner was changed")
		}
	})
	t.Run("rejects directory symlink without changing target", func(t *testing.T) {
		run("rmdir", directory)
		target := t.TempDir()
		if err := os.Chmod(target, 0o775); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, directory); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = os.Remove(directory); _ = os.Mkdir(directory, 0o755) }()
		if err := prepareOpenRCPIDDirectory(pidFile); err == nil {
			t.Fatal("symlink directory accepted")
		}
		info, _ := os.Stat(target)
		if info.Mode().Perm() != 0o775 {
			t.Fatal("symlink target was modified")
		}
	})
	t.Run("does not repair arbitrary directories", func(t *testing.T) {
		target := t.TempDir()
		if err := os.Chmod(target, 0o775); err != nil {
			t.Fatal(err)
		}
		if err := prepareOpenRCPIDDirectory(filepath.Join(target, "nginx.pid")); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(target)
		if info.Mode().Perm() != 0o775 {
			t.Fatal("unrelated directory was modified")
		}
	})
}
