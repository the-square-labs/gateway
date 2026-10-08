//go:build linux

package listenerkeep

import (
	"os"
	"strconv"
	"testing"
	"time"
)

// Flush returns once the launcher took every message the daemon sent: the
// launcher applies them before it starts the next process.
func TestFlushWaitsForTheLauncher(t *testing.T) {
	launcher, childEnd := keeperChannel(t)
	t.Setenv(launcherManagedEnv, "1")
	t.Setenv(ChannelFDEnv, strconv.Itoa(childEnd))
	t.Setenv(KeptEnv, "")
	t.Setenv("NOTIFY_SOCKET", "")
	t.Setenv("INVOCATION_ID", "")
	keeper := newClientFromEnvironment()
	if keeper.channel == nil {
		t.Fatal("the client has no launcher channel")
	}
	file := duplicateListener(t, listenUnix(t, "conn.sock"))
	if err := keeper.keep("conn/1", file); err != nil {
		t.Fatal(err)
	}
	if err := flushChannel(keeper.channel, 10*time.Millisecond); err == nil {
		t.Fatal("the launcher took a message it never read")
	}
	if message := readLauncher(t, launcher); message != "keep\nconn/1" {
		t.Fatalf("the launcher got %q", message)
	}
	if err := flushChannel(keeper.channel, time.Second); err != nil {
		t.Fatalf("flush after the launcher read everything: %v", err)
	}
}

// A connection or a snapshot handed to the next process (live handover) lives
// in the launcher only: the daemon does not store it in systemd's store on the
// launcher's behalf, as it does for listeners.
func TestKeeperLeavesHandoverItemsOutOfSystemd(t *testing.T) {
	if !notifyOnBehalfSupported || os.Geteuid() != 0 {
		t.Skip("notifying on behalf of another process needs Linux and root")
	}
	notify := listenNotify(t)
	launcher, childEnd := keeperChannel(t)
	t.Setenv(launcherManagedEnv, "1")
	t.Setenv(ChannelFDEnv, strconv.Itoa(childEnd))
	t.Setenv(KeptEnv, "")
	t.Setenv("NOTIFY_SOCKET", "")
	t.Setenv("INVOCATION_ID", "test")
	keeper := newClientFromEnvironment()
	if keeper.mirror == nil {
		t.Fatal("the client mirrors nothing")
	}
	file := duplicateListener(t, listenUnix(t, "conn.sock"))
	if err := keeper.keep("conn/1", file); err != nil {
		t.Fatal(err)
	}
	if message := readLauncher(t, launcher); message != "keep\nconn/1" {
		t.Fatalf("the launcher got %q", message)
	}
	_ = notify.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if n, _, _, _, err := notify.ReadMsgUnix(make([]byte, maxMessage), make([]byte, 64)); err == nil {
		t.Fatalf("systemd got a handover item (%d bytes)", n)
	}
}

// EnvBytes counts what the launcher describes, so a handover stays within
// what one environment string can hold.
func TestEnvBytesCountsKeptNames(t *testing.T) {
	c := &client{inherited: map[string]*os.File{"inherited#1": nil}, own: map[string]bool{"kept#2": true}}
	globalMu.Lock()
	previous := global
	global = c
	globalMu.Unlock()
	initOnce.Do(func() {})
	t.Cleanup(func() {
		globalMu.Lock()
		global = previous
		globalMu.Unlock()
	})
	base := EnvBytes(nil)
	if base <= len(KeptEnv)+len("inherited#1")+len("kept#2") {
		t.Fatalf("EnvBytes = %d", base)
	}
	if got := EnvBytes([]string{"conn/1"}); got != base+EnvEntryBytes("conn/1") {
		t.Fatalf("EnvBytes with one name = %d, base %d", got, base)
	}
}
