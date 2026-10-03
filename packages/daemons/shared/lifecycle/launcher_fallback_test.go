package lifecycle

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// lstatDeniedUnder fails with errno for every path below denied, as the kernel
// does for a non-root daemon whose state directory belongs to root.
func lstatDeniedUnder(denied string, errno syscall.Errno) func(string) (os.FileInfo, error) {
	return func(path string) (os.FileInfo, error) {
		if strings.HasPrefix(path, denied+string(filepath.Separator)) {
			return nil, &fs.PathError{Op: "lstat", Path: path, Err: errno}
		}
		return os.Lstat(path)
	}
}

func TestStableLauncherFallsThroughDeniedStateDirectory(t *testing.T) {
	for _, errno := range []syscall.Errno{syscall.EACCES, syscall.EPERM} {
		t.Run(errno.Error(), func(t *testing.T) {
			executable := filepath.Join(t.TempDir(), "test-daemon")
			writeLauncherTestExecutable(t, executable, "v1", true)
			denied := filepath.Join(t.TempDir(), "root-owned-state")
			fallback := filepath.Join(t.TempDir(), "cache", "test")

			stateDir, launcherPath, err := ensureStableLauncherIn([]string{denied, fallback}, executable, lstatDeniedUnder(denied, errno))
			if err != nil {
				t.Fatalf("ensure stable launcher: %v", err)
			}
			if stateDir != fallback || launcherPath != canonicalLauncherPath(fallback, executable) {
				t.Fatalf("launcher placed in %q (%q), want the fallback %q", stateDir, launcherPath, fallback)
			}
			if err := probeLauncher(launcherPath); err != nil {
				t.Fatalf("fallback launcher copy does not answer the probe: %v", err)
			}
			if _, err := os.Stat(denied); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("denied state directory was touched: %v", err)
			}
		})
	}
}

func TestStableLauncherReportsEveryDeniedCandidate(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, executable, "v1", true)
	root := t.TempDir()
	candidates := []string{filepath.Join(root, "state"), filepath.Join(root, "cache")}

	_, _, err := ensureStableLauncherIn(candidates, executable, lstatDeniedUnder(root, syscall.EACCES))
	if err == nil || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("all candidates denied: error = %v, want a permission error", err)
	}
}

func TestStableLauncherStillStopsOnOtherLookupErrors(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, executable, "v1", true)
	broken := filepath.Join(t.TempDir(), "state")
	fallback := filepath.Join(t.TempDir(), "cache")

	_, _, err := ensureStableLauncherIn([]string{broken, fallback}, executable, lstatDeniedUnder(broken, syscall.EIO))
	if !errors.Is(err, syscall.EIO) {
		t.Fatalf("lookup error = %v, want EIO to stop the search", err)
	}
	if _, statErr := os.Stat(fallback); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("fallback was used after a non-permission error: %v", statErr)
	}
}

func TestStableLauncherKeepsPreferredDirectoryWhenUsable(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, executable, "v1", true)
	preferred := filepath.Join(t.TempDir(), "state")
	fallback := filepath.Join(t.TempDir(), "cache")

	stateDir, _, err := ensureStableLauncherIn([]string{preferred, fallback}, executable, os.Lstat)
	if err != nil || stateDir != preferred {
		t.Fatalf("state dir = %q, err = %v; want the preferred %q", stateDir, err, preferred)
	}
	// A second start finds the existing copy in the same place.
	stateDir, _, err = ensureStableLauncherIn([]string{preferred, fallback}, executable, os.Lstat)
	if err != nil || stateDir != preferred {
		t.Fatalf("restart state dir = %q, err = %v; want the preferred %q", stateDir, err, preferred)
	}
}

// The real kernel check, for a run as a non-root user: a state directory the
// user cannot search makes the launcher use the next candidate.
func TestStableLauncherFallsThroughUnsearchableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	executable := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, executable, "v1", true)
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(filepath.Join(locked, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	fallback := filepath.Join(t.TempDir(), "cache")

	stateDir, _, err := ensureStableLauncherIn([]string{filepath.Join(locked, "state"), fallback}, executable, os.Lstat)
	if err != nil || stateDir != fallback {
		t.Fatalf("state dir = %q, err = %v; want the fallback %q", stateDir, err, fallback)
	}
}
