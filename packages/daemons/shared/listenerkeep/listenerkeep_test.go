package listenerkeep

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// launcherClient connects a keeper client to store the way a daemon process
// started by the launcher is connected.
func launcherClient(t *testing.T, store *Store) *client {
	t.Helper()
	files, _, release := store.ChildFiles(3)
	release()
	fd, err := syscall.Dup(int(files[0].Fd()))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(launcherManagedEnv, "1")
	t.Setenv(ChannelFDEnv, strconv.Itoa(fd))
	t.Setenv(KeptEnv, "")
	current := newClientFromEnvironment()
	if !current.available() {
		t.Fatal("client is not connected to the launcher")
	}
	return current
}

func listenUnix(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	unixListener := listener.(*net.UnixListener)
	unixListener.SetUnlinkOnClose(false)
	t.Cleanup(func() { _ = unixListener.Close() })
	return unixListener
}

func keepListener(t *testing.T, current *client, listener *net.UnixListener, path string) string {
	t.Helper()
	name, err := Name(path)
	if err != nil {
		t.Fatal(err)
	}
	file, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := current.keep(name, file); err != nil {
		t.Fatal(err)
	}
	return name
}

// TestKeptListenerQueuesConnectionsForTheNextProcess is the restart B-13 relies on: once the daemon process closed
// its own listener, a connection still reaches the socket kept by the launcher and waits in its backlog, and the next
// process adopts the socket and serves it.
func TestKeptListenerQueuesConnectionsForTheNextProcess(t *testing.T) {
	store, err := OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	daemon := launcherClient(t, store)
	path := filepath.Join(t.TempDir(), "link.sock")
	listener := listenUnix(t, path)
	name := keepListener(t, daemon, listener, path)
	store.Settle(time.Second)
	if got := store.Names(); len(got) != 1 || got[0] != name {
		t.Fatalf("kept = %v, want [%s]", got, name)
	}

	// The daemon process stops: its listener closes, the socket file stays.
	_ = listener.Close()
	client, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("connect while no daemon process runs: %v", err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("GET / HTTP/1.1\r\n\r\n")); err != nil {
		t.Fatal(err)
	}

	// The launcher starts the next daemon process with the kept listener.
	files, environment, release := store.ChildFiles(3)
	defer release()
	if len(files) != 2 {
		t.Fatalf("child files = %d, want the channel and one listener", len(files))
	}
	kept := ""
	for _, variable := range environment {
		if value, ok := strings.CutPrefix(variable, KeptEnv+"="); ok {
			kept = value
		}
	}
	if !strings.Contains(kept, `"fd":4`) || !strings.Contains(kept, name) {
		t.Fatalf("kept listeners = %s", kept)
	}
	adopted, err := net.FileListener(files[1])
	if err != nil {
		t.Fatal(err)
	}
	defer adopted.Close()
	served, err := adopted.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer served.Close()
	request := make([]byte, 18)
	if _, err := io.ReadFull(served, request); err != nil || string(request) != "GET / HTTP/1.1\r\n\r\n" {
		t.Fatalf("request = %q, %v", request, err)
	}
}

func TestDroppedListenerIsClosedByTheKeeper(t *testing.T) {
	store, err := OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	daemon := launcherClient(t, store)
	path := filepath.Join(t.TempDir(), "link.sock")
	listener := listenUnix(t, path)
	name := keepListener(t, daemon, listener, path)
	if err := daemon.drop(name); err != nil {
		t.Fatal(err)
	}
	store.Settle(time.Second)
	if got := store.Names(); len(got) != 0 {
		t.Fatalf("kept = %v after the drop", got)
	}
	_ = listener.Close()
	if _, err := net.Dial("unix", path); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("connect after every copy closed = %v, want a refusal", err)
	}
}

func TestKeepReplacesTheCopyKeptUnderTheSameName(t *testing.T) {
	store, err := OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	daemon := launcherClient(t, store)
	path := filepath.Join(t.TempDir(), "link.sock")
	listener := listenUnix(t, path)
	first := keepListener(t, daemon, listener, path)
	second := keepListener(t, daemon, listener, path)
	store.Settle(time.Second)
	if first != second || len(store.Names()) != 1 {
		t.Fatalf("kept = %v", store.Names())
	}
}

// TestKeeperMirrorsIntoSystemdStore: a daemon that is the unit's main process (no launcher) stores its listeners in
// systemd's file descriptor store, replacing any copy under the same name.
func TestKeeperMirrorsIntoSystemdStore(t *testing.T) {
	notifyPath := filepath.Join(t.TempDir(), "notify")
	notify, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: notifyPath, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer notify.Close()
	t.Setenv(launcherManagedEnv, "")
	t.Setenv("NOTIFY_SOCKET", notifyPath)
	t.Setenv("LISTEN_PID", "")
	t.Setenv("LISTEN_FDS", "")
	direct := newClientFromEnvironment()
	path := filepath.Join(t.TempDir(), "link.sock")
	listener := listenUnix(t, path)
	name := keepListener(t, direct, listener, path)

	buffer := make([]byte, 512)
	oob := make([]byte, syscall.CmsgSpace(4))
	_ = notify.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, _, _, err := notify.ReadMsgUnix(buffer, oob)
	if err != nil || string(buffer[:n]) != "FDSTOREREMOVE=1\nFDNAME="+name+"\n" {
		t.Fatalf("first message = %q, %v", buffer[:n], err)
	}
	n, oobn, _, _, err := notify.ReadMsgUnix(buffer, oob)
	if err != nil || string(buffer[:n]) != "FDSTORE=1\nFDNAME="+name+"\n" {
		t.Fatalf("second message = %q, %v", buffer[:n], err)
	}
	if files := receivedFiles(oob[:oobn]); len(files) != 1 {
		t.Fatalf("stored descriptors = %d", len(files))
	} else {
		_ = files[0].Close()
	}
	if err := direct.drop(name); err != nil {
		t.Fatal(err)
	}
	n, _, _, _, err = notify.ReadMsgUnix(buffer, oob)
	if err != nil || string(buffer[:n]) != "FDSTOREREMOVE=1\nFDNAME="+name+"\n" {
		t.Fatalf("drop message = %q, %v", buffer[:n], err)
	}
}

func TestSystemdListenersAreAdoptedByName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "link.sock")
	listener := listenUnix(t, path)
	file, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	name, _ := Name(path)
	t.Setenv("LISTEN_PID", strconv.Itoa(os.Getpid()))
	t.Setenv("LISTEN_FDS", "1")
	t.Setenv("LISTEN_FDNAMES", name)
	fd, err := syscall.Dup(int(file.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	adopted := takeListenFDs(fd)
	if got := adopted[name]; got == nil {
		t.Fatalf("adopted = %v", adopted)
	} else {
		_ = got.Close()
	}
	if os.Getenv("LISTEN_FDS") != "" || os.Getenv("LISTEN_PID") != "" {
		t.Fatal("LISTEN_* must be cleared for helper processes")
	}
}

func TestNameChangesWhenTheSocketIsRecreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "link.sock")
	first := listenUnix(t, path)
	before, err := Name(path)
	if err != nil {
		t.Fatal(err)
	}
	// Re-created the way the nginx daemon does: bound under another name and
	// renamed over the path, while the first socket file still exists.
	next := filepath.Join(filepath.Dir(path), "next.sock")
	listenUnix(t, next)
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	after, err := Name(path)
	if err != nil {
		t.Fatal(err)
	}
	if before == after || NamePath(after) != path {
		t.Fatalf("names %s and %s", before, after)
	}
}
