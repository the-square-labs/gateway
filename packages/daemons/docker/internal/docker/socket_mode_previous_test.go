package docker

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/listenerkeep"
)

// A root → non-root switch: the egress socket the root process handed over does not fit the new mode (0600, or set
// aside with its directory). A connection a connector made during the switch waits in its backlog and is served by
// the next process, and so is one the previous mode's connector makes through it afterwards; once that connector is
// retired the socket is dropped from the listener keeper. Before, the next process neither served nor dropped it:
// the connections hung, and the keeper held the socket for good.
func TestModeSwitchPreviousSockets(t *testing.T) {
	previousUID, previousGID := daemonEUID, daemonEGID
	t.Cleanup(func() { daemonEUID, daemonEGID = previousUID, previousGID })
	uid, gid := os.Geteuid(), os.Getegid()
	if uid == 0 {
		uid, gid = 4242, 4242
	}
	daemonEUID = func() int { return uid }
	daemonEGID = func() int { return gid }
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	base := t.TempDir()
	// The socket stays where it was with the root mode, and one whose directory is set aside.
	inPlace := filepath.Join(base, "a", egressSocketName)
	setAside := filepath.Join(base, "b", egressSocketName)
	for _, path := range []string{inPlace, setAside} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	keptNames := []string{
		keepSocketForNextProcess(t, store, inPlace, 0o600, uid, gid),
		keepSocketForNextProcess(t, store, setAside, 0o600, uid, gid),
	}
	// Connections the connectors make while no daemon process runs.
	waiting := []net.Conn{}
	for _, path := range []string{inPlace, setAside} {
		connection, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		waiting = append(waiting, connection)
	}
	asideDirectory := filepath.Join(base, "b.aside")
	if err := os.Rename(filepath.Dir(setAside), asideDirectory); err != nil {
		t.Fatal(err)
	}

	connectKeeper(t, store, inheritedFrom(t, store))
	var previous previousUnixListeners
	for _, path := range []string{inPlace, setAside} {
		kept, _, others := adoptKeptUnixListeners(path, storageConnectorSocketFits)
		if kept != nil || len(others) != 1 {
			t.Fatalf("%s: adopted %v as this mode's socket, %d of the previous mode", path, kept != nil, len(others))
		}
		previous.serve(others, func(connection net.Conn) {
			defer connection.Close()
			line, _ := bufio.NewReader(connection).ReadString('\n')
			_, _ = fmt.Fprint(connection, strings.ToUpper(line))
		})
	}
	served := func(connection net.Conn, what string) {
		t.Helper()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = fmt.Fprint(connection, "hello\n")
		if line, err := bufio.NewReader(connection).ReadString('\n'); err != nil || line != "HELLO\n" {
			t.Fatalf("%s was not served: %q, %v", what, line, err)
		}
	}
	for index, connection := range waiting {
		served(connection, fmt.Sprintf("connection %d made during the switch", index))
	}
	// The previous mode's connector still reaches the set-aside socket through its mount.
	later, err := net.DialTimeout("unix", filepath.Join(asideDirectory, egressSocketName), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer later.Close()
	served(later, "a connection of the previous mode's connector after the switch")

	previous.retire()
	if previous.count() != 0 {
		t.Fatal("previous mode sockets still served after their connector was retired")
	}
	store.Settle(time.Second)
	for _, name := range keptNames {
		if slices.Contains(store.Names(), name) {
			t.Fatalf("the listener keeper still holds %s", name)
		}
	}
}
