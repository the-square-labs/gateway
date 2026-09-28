package server

import (
	"context"
	"io"
	"net"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// capturingListener records the connections the liveness listener accepted.
type capturingListener struct {
	net.Listener
	mu       sync.Mutex
	accepted []net.Conn
}

func (l *capturingListener) Accept() (net.Conn, error) {
	connection, err := l.Listener.Accept()
	if err == nil {
		l.mu.Lock()
		l.accepted = append(l.accepted, connection)
		l.mu.Unlock()
	}
	return connection, err
}

// holdServer runs a gRPC server with the relay's peer liveness whose only
// stream stays open until its transport closes, like an endpoint
// registration or a bridged tunnel, and reports when that happened.
func holdServer(t *testing.T) (address string, listener *capturingListener, opened <-chan struct{}, ended <-chan time.Time) {
	t.Helper()
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener = &capturingListener{Listener: withPeerLiveness(base)}
	openedCh := make(chan struct{}, 1)
	endedCh := make(chan time.Time, 1)
	server := grpc.NewServer(grpc.KeepaliveParams(peerKeepalive()), grpc.UnknownServiceHandler(func(_ any, stream grpc.ServerStream) error {
		openedCh <- struct{}{}
		<-stream.Context().Done()
		endedCh <- time.Now()
		return nil
	}))
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return base.Addr().String(), listener, openedCh, endedCh
}

func openHold(t *testing.T, address string, dial func(context.Context, string) (net.Conn, error)) {
	t.Helper()
	options := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	if dial != nil {
		options = append(options, grpc.WithContextDialer(dial))
	}
	conn, err := grpc.NewClient(address, options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if _, err := conn.NewStream(context.Background(), &grpc.StreamDesc{ServerStreams: true, ClientStreams: true}, "/test.Liveness/Hold"); err != nil {
		t.Fatal(err)
	}
}

func waitOpened(t *testing.T, opened <-chan struct{}) {
	t.Helper()
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not open")
	}
}

// TestBlackHoledPeerIsDroppedWithinThreeSeconds is N-12: the host of an endpoint's daemon drops off the network
// (every packet to it is lost, nothing is answered). The relay closes its connection, ending the registration and
// the tunnels on it, within about peerPingInterval + peerAckTimeout, not after the 40 s of the old keepalive.
func TestBlackHoledPeerIsDroppedWithinThreeSeconds(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("TCP_USER_TIMEOUT and socket filters are Linux")
	}
	t.Parallel()
	address, listener, opened, ended := holdServer(t)
	dialed := make(chan net.Conn, 1)
	openHold(t, address, func(ctx context.Context, target string) (net.Conn, error) {
		connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", target)
		if err == nil {
			dialed <- connection
		}
		return connection, err
	})
	waitOpened(t, opened)
	listener.mu.Lock()
	server := listener.accepted[0]
	listener.mu.Unlock()
	if timeout, err := ackTimeout(server); err != nil || timeout != peerAckTimeout {
		t.Fatalf("accepted connection TCP_USER_TIMEOUT = %s, %v", timeout, err)
	}

	// Black-hole the peer: its socket drops every packet the relay sends, so
	// nothing is acknowledged (a socket filter returning 0 drops before TCP).
	client := <-dialed
	raw, err := client.(*net.TCPConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var filterErr error
	if err := raw.Control(func(fd uintptr) {
		filterErr = syscall.AttachLsf(int(fd), []syscall.SockFilter{{Code: 0x06, K: 0}})
	}); err != nil || filterErr != nil {
		t.Fatalf("attach drop filter: %v %v", err, filterErr)
	}
	started := time.Now()
	select {
	case at := <-ended:
		if elapsed := at.Sub(started); elapsed > peerPingInterval+peerAckTimeout+time.Second {
			t.Fatalf("black-holed peer dropped after %s", elapsed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("black-holed peer was never dropped")
	}
}

// TestQuietLivePeerKeepsItsConnection: a registration or tunnel that carries nothing for a while (an app taking
// long to answer, an idle endpoint) is kept: pings are answered.
func TestQuietLivePeerKeepsItsConnection(t *testing.T) {
	t.Parallel()
	address, _, opened, ended := holdServer(t)
	openHold(t, address, nil)
	waitOpened(t, opened)
	select {
	case <-ended:
		t.Fatal("a quiet but live peer lost its connection")
	case <-time.After(4 * peerPingInterval):
	}
}

// TestBusyPeerIsNotDroppedEarly: a peer whose host still acknowledges but whose process does not answer pings
// for a while (a stalled daemon, a Gateway busy for a few seconds) keeps its connection for peerPingTimeout: only
// an unreachable host is dropped fast.
func TestBusyPeerIsNotDroppedEarly(t *testing.T) {
	t.Parallel()
	address, _, opened, ended := holdServer(t)
	// A proxy that stops forwarding: the kernel still acknowledges every
	// byte, but no ping reaches the gRPC client any more.
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close() })
	frozen := make(chan struct{})
	go func() {
		downstream, err := proxy.Accept()
		if err != nil {
			return
		}
		upstream, err := net.Dial("tcp", address)
		if err != nil {
			return
		}
		forward := func(to io.Writer, from io.Reader) {
			buffer := make([]byte, 32*1024)
			for {
				n, err := from.Read(buffer)
				if err != nil {
					return
				}
				select {
				case <-frozen:
					<-make(chan struct{})
				default:
				}
				if _, err := to.Write(buffer[:n]); err != nil {
					return
				}
			}
		}
		go forward(upstream, downstream)
		forward(downstream, upstream)
	}()
	openHold(t, proxy.Addr().String(), nil)
	waitOpened(t, opened)
	close(frozen)
	select {
	case <-ended:
		t.Fatal("a peer that stopped answering pings but still acknowledges was dropped within 4 s")
	case <-time.After(4 * time.Second):
	}
}
