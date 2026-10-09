//go:build linux

package slowstart

import (
	"io"
	"net"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func tcpPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	return client.(*net.TCPConn), server.(*net.TCPConn)
}

func congestionControl(t *testing.T, conn syscall.Conn) string {
	t.Helper()
	raw, err := conn.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var name string
	var getErr error
	if err := raw.Control(func(fd uintptr) {
		name, getErr = unix.GetsockoptString(int(fd), unix.IPPROTO_TCP, unix.TCP_CONGESTION)
	}); err != nil {
		t.Fatal(err)
	}
	if getErr != nil {
		t.Fatal(getErr)
	}
	return name
}

// A write after a pause restarts CUBIC while a slow start is ahead (a new
// connection: no threshold yet), and the connection stays on CUBIC.
func TestGuardRestartsCubicBeforeASlowStart(t *testing.T) {
	client, server := tcpPair(t)
	if congestionControl(t, client) != cubic {
		t.Skip("the system's congestion control is not CUBIC")
	}
	guard := New(client)
	if guard == nil {
		t.Skip("this process may not switch the congestion control")
	}
	go func() { _, _ = io.Copy(io.Discard, server) }()
	write := func(n int) {
		guard.BeforeWrite()
		if _, err := client.Write(make([]byte, n)); err != nil {
			t.Fatal(err)
		}
	}
	write(1000)
	time.Sleep(2 * Pause)
	state, ok := guard.sys.info()
	if !ok || state.cwnd >= state.ssthresh {
		t.Skipf("no slow start ahead on this connection: %+v", state)
	}
	before := Resets()
	write(1000)
	if Resets() != before+1 {
		t.Fatalf("a write after a pause restarted CUBIC %d times", Resets()-before)
	}
	if name := congestionControl(t, client); name != cubic {
		t.Fatalf("congestion control %q after the restart", name)
	}
	// Bulk writes in a row: no pause; logged only (a loaded host can stretch a
	// loopback round trip).
	before = Resets()
	for range 200 {
		write(256 << 10)
	}
	t.Logf("restarts during bulk writes: %d", Resets()-before)
}
