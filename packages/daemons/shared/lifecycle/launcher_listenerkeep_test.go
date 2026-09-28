package lifecycle

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/listenerkeep"
)

// TestLauncherHandsKeptListenersToTheChild: every daemon process the launcher starts receives the channel to the
// listener keeper and the listeners kept so far, as the descriptors the environment names (B-13).
func TestLauncherHandsKeptListenersToTheChild(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	socketPath := filepath.Join(t.TempDir(), "link.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	name, err := listenerkeep.Name(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	// Keep it the way a daemon process does, through the channel end handed to children.
	files, _, release := store.ChildFiles(3)
	release()
	channel, err := net.FileConn(files[0])
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	listenerFile, err := listener.(*net.UnixListener).File()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := channel.(*net.UnixConn).WriteMsgUnix([]byte("keep\n"+name), syscall.UnixRights(int(listenerFile.Fd())), nil); err != nil {
		t.Fatal(err)
	}
	_ = listenerFile.Close()
	store.Settle(time.Second)

	stateDir := t.TempDir()
	launcherDir := filepath.Join(stateDir, "launcher")
	if err := ensurePrivateLauncherDirectory(launcherDir); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireLauncherLock(context.Background(), filepath.Join(launcherDir, "owner.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	marker := filepath.Join(t.TempDir(), "child-env")
	binary := filepath.Join(t.TempDir(), "test-daemon")
	script := "#!/bin/sh\n" +
		"{ echo \"channel=$GATEWAY_DAEMON_LISTENER_KEEP_FD\"; echo \"kept=$GATEWAY_DAEMON_KEPT_LISTENERS\"; " +
		"echo \"fd5=$(readlink /proc/$$/fd/5)\"; echo \"fd6=$(readlink /proc/$$/fd/6)\"; } > " + marker + ".tmp\n" +
		"mv " + marker + ".tmp " + marker + "\n" +
		"trap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n"
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	child, _, done, err := startLauncherChild(LauncherSpec{DaemonType: "nginx", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, lock, store)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = terminateLauncherChild(child, done, time.Second) }()
	waitForLauncherPath(t, marker, true)
	contents, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	report := string(contents)
	for _, want := range []string{"channel=5\n", `"fd":6`, name, "fd5=socket:", "fd6=socket:"} {
		if !strings.Contains(report, want) {
			t.Fatalf("child saw:\n%s\nmissing %q", report, want)
		}
	}
}
