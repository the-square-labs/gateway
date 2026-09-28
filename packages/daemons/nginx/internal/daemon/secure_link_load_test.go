package daemon

import (
	"errors"
	"io"
	"net"
	"os"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// B-22: peers are authorized from their socket credentials against the cached master PID; a worker verified once
// is not looked up in /proc again, and nothing runs a subprocess.
func TestPeerAuthorityVerifiesAWorkerOnce(t *testing.T) {
	var masters, checks atomic.Int32
	authority := newNginxPeerAuthority("/usr/sbin/nginx", func() (int, error) { masters.Add(1); return 10, nil })
	authority.isManaged = func(peerPID, masterPID int, _ string) bool { checks.Add(1); return peerPID == 11 && masterPID == 10 }
	now := time.Now()
	for range 1000 {
		if !authority.authorizePeer(unixPeerIdentity{pid: 11, uid: 101}, now) {
			t.Fatal("the managed worker was refused")
		}
	}
	if got := checks.Load(); got != 1 {
		t.Fatalf("/proc checks for one worker = %d", got)
	}
	if authority.authorizePeer(unixPeerIdentity{pid: 12, uid: 101}, now) {
		t.Fatal("a foreign process was authorized")
	}
	// Another uid under the same PID, a new master, or an expired entry are checked again.
	authority.authorizePeer(unixPeerIdentity{pid: 11, uid: 0}, now)
	authority.authorizePeer(unixPeerIdentity{pid: 11, uid: 101}, now.Add(peerAuthorizationTTL))
	if got := checks.Load(); got != 4 {
		t.Fatalf("checks = %d, want the uid change and the expiry checked again", got)
	}
	var uids atomic.Int32
	authority.workerUID = func(int, string) (int, error) { uids.Add(1); return 101, nil }
	for range 100 {
		if uid, err := authority.socketOwnerUID(); err != nil || uid != 101 {
			t.Fatalf("worker uid = %d, %v", uid, err)
		}
	}
	if got := uids.Load(); got != 1 {
		t.Fatalf("worker uid scans = %d", got)
	}
}

func loadTestManager(t *testing.T, authorize func(net.Conn) bool, opener func(string, net.Conn), configure ...func(*sourceLinkManager)) (*sourceLinkManager, string) {
	t.Helper()
	manager := testSourceLinkManager(t, opener)
	manager.authorizeUnixPeer = authorize
	for _, apply := range configure {
		apply(manager)
	}
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	return manager, statuses[0].SocketPath
}

func request(t *testing.T, path string) (net.Conn, error) {
	t.Helper()
	connection, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return nil, err
	}
	_, err = connection.Write([]byte("GET / HTTP/1.1\r\n\r\n"))
	return connection, err
}

// B-22 (2): one slow authorization must not hold up the accept loop: the next connections are accepted and served.
func TestAcceptLoopKeepsServingWhileAnAuthorizationIsSlow(t *testing.T) {
	var first atomic.Bool
	release := make(chan struct{})
	served := make(chan struct{}, 16)
	_, path := loadTestManager(t, func(net.Conn) bool {
		if first.CompareAndSwap(false, true) {
			<-release
		}
		return true
	}, func(_ string, connection net.Conn) {
		secureLinkEstablished(connection)
		served <- struct{}{}
		_ = connection.Close()
	})
	defer close(release)
	slow, err := request(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	time.Sleep(50 * time.Millisecond)
	for i := 0; i < 5; i++ {
		connection, err := request(t, path)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		select {
		case <-served:
		case <-time.After(2 * time.Second):
			t.Fatalf("connection %d waited behind a slow authorization", i)
		}
	}
}

// B-22 (2)/(3): beyond the setup limit a connection is closed at once instead of queueing; once the load is gone
// the listener serves again by itself.
func TestSetupLimitShedsAndRecovers(t *testing.T) {
	block := make(chan struct{})
	served := make(chan struct{}, 64)
	manager, path := loadTestManager(t, func(net.Conn) bool { return true }, func(_ string, connection net.Conn) {
		select {
		case <-block:
			secureLinkEstablished(connection)
			served <- struct{}{}
		default:
			<-block
		}
		_ = connection.Close()
	}, func(manager *sourceLinkManager) { manager.setup.limit.Store(4) })
	var held []net.Conn
	for range 4 {
		connection, err := request(t, path)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, connection)
	}
	deadline := time.Now().Add(2 * time.Second)
	for manager.setup.inFlight.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	shed, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer shed.Close()
	_ = shed.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := shed.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("a connection beyond the limit was not closed at once: %v", err)
	}
	if manager.shed.Load() == 0 {
		t.Fatal("no connection was counted as shed")
	}
	close(block)
	for manager.setup.inFlight.Load() > 0 && time.Now().Before(deadline.Add(2*time.Second)) {
		time.Sleep(5 * time.Millisecond)
	}
	for _, connection := range held {
		_ = connection.Close()
	}
	connection, err := request(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-served:
	case <-time.After(2 * time.Second):
		t.Fatal("the listener did not serve again after the load")
	}
}

// B-22 (3): after an overload the backlog holds connections nginx gave up on. They are dropped without opening a
// relay tunnel; a live connection's first bytes reach the opener intact.
func TestDeadOnArrivalConnectionsAreDroppedWithoutATunnel(t *testing.T) {
	var opened atomic.Int32
	got := make(chan string, 4)
	_, path := loadTestManager(t, func(net.Conn) bool { return true }, func(_ string, connection net.Conn) {
		opened.Add(1)
		buffer := make([]byte, 18)
		if _, err := io.ReadFull(connection, buffer); err == nil {
			got <- string(buffer)
		}
		_ = connection.Close()
	})
	for range 20 {
		dead, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = dead.Close()
	}
	live, err := request(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	select {
	case request := <-got:
		if request != "GET / HTTP/1.1\r\n\r\n" {
			t.Fatalf("opener read %q", request)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the live connection was not served")
	}
	time.Sleep(100 * time.Millisecond)
	if n := opened.Load(); n != 1 {
		t.Fatalf("opened %d tunnels, want only the live connection's", n)
	}
}

func TestAuthorizationThatDoesNotFinishRefusesTheConnection(t *testing.T) {
	hang := make(chan struct{})
	defer close(hang)
	var opened atomic.Int32
	_, path := loadTestManager(t, func(net.Conn) bool { <-hang; return true }, func(_ string, connection net.Conn) {
		opened.Add(1)
		_ = connection.Close()
	}, func(manager *sourceLinkManager) { manager.authorizeTimeout = 100 * time.Millisecond })
	connection, err := request(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the connection to be closed")
	}
	if opened.Load() != 0 {
		t.Fatal("an unauthorized connection was opened")
	}
}

// A transient accept error (out of descriptors) must not end the accept loop: that left a listener dead forever.
type flakyListener struct {
	net.Listener
	failures atomic.Int32
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.failures.Add(-1) >= 0 {
		return nil, &net.OpError{Op: "accept", Net: "unix", Err: syscall.EMFILE}
	}
	return l.Listener.Accept()
}

func TestAcceptLoopSurvivesTransientErrors(t *testing.T) {
	served := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		served <- struct{}{}
		_ = connection.Close()
	})
	manager.authorizeUnixPeer = func(net.Conn) bool { return true }
	path := manager.socketDir + "/flaky.sock"
	inner, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	flaky := &flakyListener{Listener: inner}
	flaky.failures.Store(5)
	binding := &sourceLinkBinding{done: make(chan struct{}), active: map[net.Conn]bool{}}
	manager.accept("11111111-1111-4111-8111-111111111111", binding, flaky, true)
	defer func() { close(binding.done); _ = inner.Close() }()
	connection, err := request(t, path)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-served:
	case <-time.After(3 * time.Second):
		t.Fatal("the accept loop ended on a transient error")
	}
}
