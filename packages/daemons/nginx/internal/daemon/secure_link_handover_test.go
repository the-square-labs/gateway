package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/listenerkeep"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testMemberLinkID = "22222222-2222-4222-8222-222222222222"

// connectKeeper makes this test process a daemon process started by a launcher whose keeper is store, having
// inherited the listeners in inherited (keeper name -> descriptor).
func connectKeeper(t *testing.T, store *listenerkeep.Store, inherited map[string]*os.File) {
	t.Helper()
	files, _, release := store.ChildFiles(3)
	release()
	channel, err := syscall.Dup(int(files[0].Fd()))
	if err != nil {
		t.Fatal(err)
	}
	type kept struct {
		Name string `json:"name"`
		FD   int    `json:"fd"`
	}
	descriptors := []kept{}
	for name, file := range inherited {
		// The process owns what it inherits and closes it once adopted: it gets
		// its own descriptor, or the *os.File would close the same number again
		// later, when another test may be using it for a connection.
		descriptor, err := syscall.Dup(int(file.Fd()))
		if err != nil {
			t.Fatal(err)
		}
		descriptors = append(descriptors, kept{Name: name, FD: descriptor})
	}
	encoded, _ := json.Marshal(descriptors)
	t.Setenv("GATEWAY_DAEMON_LAUNCHER_MANAGED", "1")
	t.Setenv(listenerkeep.ChannelFDEnv, strconv.Itoa(channel))
	t.Setenv(listenerkeep.KeptEnv, string(encoded))
	listenerkeep.ReinitForTest()
	t.Cleanup(func() {
		_ = os.Unsetenv("GATEWAY_DAEMON_LAUNCHER_MANAGED")
		listenerkeep.ReinitForTest()
	})
}

// inheritedFrom hands the listeners store keeps to the next process, the way the launcher starts it.
func inheritedFrom(t *testing.T, store *listenerkeep.Store) map[string]*os.File {
	t.Helper()
	store.Settle(time.Second)
	names := store.Names()
	files, _, _ := store.ChildFiles(3)
	inherited := map[string]*os.File{}
	for index, name := range names {
		inherited[name] = files[1+index]
	}
	return inherited
}

func plainAndMemberCommand() *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: testSecureLinkID, Role: "source", Generation: 1, SocketOnly: true},
		{
			LinkId: testMemberLinkID, Role: "source", Generation: 1, SocketOnly: true,
			AvailabilityPolicyId: "policy-1", AvailabilityCandidateId: "node-a",
		},
	}}
}

func holderView(holder string) *relayv1.LeaseGateSnapshot {
	return &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: holder, RemainingMs: 30000,
		HolderEndpoint: relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY,
	}}}
}

// TestRestartHandsSecureLinkSocketsToTheNextProcess is B-13: an nginx-daemon restart or update refuses no
// connection. The stopping process hands its sockets to the listener keeper; a connection made while no process runs
// waits in the socket's backlog, and the next process adopts the socket and serves it. The holder's member socket
// stays open through the restart, before any relay reported on its lease again.
func TestRestartHandsSecureLinkSocketsToTheNextProcess(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)

	first := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := first.sync(plainAndMemberCommand())
	if err != nil || len(statuses) != 2 {
		t.Fatalf("sync: %#v %v", statuses, err)
	}
	paths := map[string]string{}
	for _, status := range statuses {
		paths[status.LinkID] = status.SocketPath
	}
	if err := first.setLeaseOpen(testMemberLinkID, true); err != nil {
		t.Fatal(err)
	}
	store.Settle(time.Second)
	if kept := store.Names(); len(kept) != 2 {
		t.Fatalf("kept = %v, want the plain and the open member socket", kept)
	}

	// The daemon is asked to stop.
	if handed := first.suspendForHandover(); handed != 2 {
		t.Fatalf("handed over %d sockets", handed)
	}
	if _, _, err := first.listenUnixSocket(paths[testSecureLinkID]); err == nil {
		t.Fatal("a stopping process must not re-create a socket its successor adopts")
	}
	waiting := map[string]net.Conn{}
	for id, path := range paths {
		connection, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatalf("connect to %s while no daemon process serves it: %v", id, err)
		}
		defer connection.Close()
		if _, err := connection.Write([]byte(id)); err != nil {
			t.Fatal(err)
		}
		waiting[id] = connection
	}

	// The next process starts with the kept sockets.
	connectKeeper(t, store, inheritedFrom(t, store))
	served := make(chan string, 4)
	second := testSourceLinkManager(t, func(id string, connection net.Conn) {
		buffer := make([]byte, len(id))
		if _, err := io.ReadFull(connection, buffer); err == nil {
			served <- string(buffer)
		}
		_ = connection.Close()
	})
	second.socketDir = first.socketDir
	if _, err := second.sync(plainAndMemberCommand()); err != nil {
		t.Fatal(err)
	}
	for range paths {
		select {
		case id := <-served:
			if _, ok := waiting[id]; !ok {
				t.Fatalf("served unexpected %q", id)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a connection made during the restart was not served by the next process")
		}
	}
	if released := listenerkeep.ReleaseUnclaimed(first.socketDir + "/"); len(released) != 0 {
		t.Fatalf("sockets left unclaimed: %v", released)
	}

	// No relay reported on the policy yet: the holder's socket stays open.
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), second, nil)
	defer coordinator.close()
	coordinator.reconcileSockets()
	connection, err := net.DialTimeout("unix", paths[testMemberLinkID], time.Second)
	if err != nil {
		t.Fatalf("the holder's socket closed before any relay reported: %v", err)
	}
	_ = connection.Close()
	// The relays report another holder: it closes like any member socket.
	coordinator.gates.apply("relay-1", holderView("node-b"), time.Now())
	coordinator.reconcileSockets()
	if _, err := net.DialTimeout("unix", paths[testMemberLinkID], time.Second); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("connect to a closed member socket = %v, want a refusal", err)
	}
}

// TestLeaseClosedMemberSocketRefusesInsteadOfVanishing is B-13 and M-2: a member socket the lease gate closes stays
// on disk and refuses (ECONNREFUSED, before nginx sends a byte), reopening replaces it in one step, and the path is
// never missing nor a socket nginx may not use.
func TestLeaseClosedMemberSocketRefusesInsteadOfVanishing(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: %#v %v", statuses, err)
	}
	path := statuses[0].SocketPath
	var missing atomic.Int32
	stop := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if info, err := os.Lstat(path); err != nil {
				missing.Add(1)
			} else if info.Mode().Perm() != 0o600 {
				missing.Add(1)
			}
		}
	}()
	for cycle := 0; cycle < 50; cycle++ {
		if err := manager.setLeaseOpen(testSecureLinkID, true); err != nil {
			t.Fatal(err)
		}
		connection, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatalf("open socket refused: %v", err)
		}
		_ = connection.Close()
		if err := manager.setLeaseOpen(testSecureLinkID, false); err != nil {
			t.Fatal(err)
		}
		if _, err := net.DialTimeout("unix", path, time.Second); !errors.Is(err, syscall.ECONNREFUSED) {
			t.Fatalf("closed socket: %v, want ECONNREFUSED", err)
		}
	}
	close(stop)
	<-watched
	if got := missing.Load(); got != 0 {
		t.Fatalf("the socket path was missing or not 0600 %d times while it was re-created", got)
	}
}

// TestRefusedSocketRefusesWhateverProcessHoldsACopy: the listener keeper holds a copy of every kept socket, yet a
// member the lease gate closes must refuse at once rather than queue connections nobody accepts.
func TestRefusedSocketRefusesWhateverProcessHoldsACopy(t *testing.T) {
	path := t.TempDir() + "/member.sock"
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	copyFile, err := listener.(*net.UnixListener).File()
	if err != nil {
		t.Fatal(err)
	}
	defer copyFile.Close()
	refuseNewConnections(listener)
	if _, err := net.DialTimeout("unix", path, time.Second); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("connect = %v, want ECONNREFUSED while a copy is open", err)
	}
}

func TestHandoverDrainClosesIdleConnectionsAndWaitsForRequests(t *testing.T) {
	now := time.Now()
	idle := &trackedConn{}
	idle.lastRead.Store(now.Add(-time.Second).UnixNano())
	idle.lastWrite.Store(now.Add(-500 * time.Millisecond).UnixNano())
	waitingForAnswer := &trackedConn{}
	waitingForAnswer.lastWrite.Store(now.Add(-time.Second).UnixNano())
	waitingForAnswer.lastRead.Store(now.Add(-500 * time.Millisecond).UnixNano())
	streaming := &trackedConn{}
	streaming.lastRead.Store(now.Add(-time.Second).UnixNano())
	streaming.lastWrite.Store(now.Add(-10 * time.Millisecond).UnixNano())
	fresh := &trackedConn{accepted: now.UnixNano()}
	for name, test := range map[string]struct {
		connection *trackedConn
		idle       bool
	}{
		"answered and quiet":         {idle, true},
		"request waiting for answer": {waitingForAnswer, false},
		"answer still streaming":     {streaming, false},
		"not served yet":             {fresh, false},
	} {
		if got := test.connection.idle(now, secureLinkIdleQuiet); got != test.idle {
			t.Errorf("%s: idle = %v", name, got)
		}
	}

	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		buffer := make([]byte, 64)
		for {
			n, err := connection.Read(buffer)
			if err != nil {
				return
			}
			if string(buffer[:n]) == "request" {
				_, _ = connection.Write([]byte("answer"))
			}
		}
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	keepalive, err := net.Dial("unix", statuses[0].SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer keepalive.Close()
	_, _ = keepalive.Write([]byte("request"))
	answer := make([]byte, 6)
	if _, err := io.ReadFull(keepalive, answer); err != nil {
		t.Fatal(err)
	}
	busy, err := net.Dial("unix", statuses[0].SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	_, _ = busy.Write([]byte("request"))
	_, _ = io.ReadFull(busy, answer)
	_, _ = busy.Write([]byte("slow request"))
	time.Sleep(2 * secureLinkIdleQuiet)

	started := time.Now()
	manager.drainForHandover(400*time.Millisecond, secureLinkIdleQuiet)
	if elapsed := time.Since(started); elapsed < 350*time.Millisecond {
		t.Fatalf("drain returned after %s with a request unanswered", elapsed)
	}
	_ = keepalive.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := keepalive.Read(answer); err == nil {
		t.Fatal("the idle keepalive connection was not closed")
	}
	_ = busy.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, err := busy.Read(answer); err == nil || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("the connection waiting for its answer was closed: %v", err)
	}
}

// After the handover a connection that answered is closed once it was silent
// for the short finish quiet, not the idle quiet nginx's reuse never leaves
// it under load, and the last pass closes every answered connection before the
// exit: only a request still waiting for its answer is left for the exit.
func TestHandoverFinishClosesAnsweredConnectionsBeforeTheExit(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		buffer := make([]byte, 64)
		for {
			n, err := connection.Read(buffer)
			if err != nil {
				return
			}
			if string(buffer[:n]) == "request" {
				_, _ = connection.Write([]byte("answer"))
			}
		}
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	dial := func() net.Conn {
		connection, err := net.Dial("unix", statuses[0].SocketPath)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = connection.Close() })
		return connection
	}
	answered := func(connection net.Conn) {
		_, _ = connection.Write([]byte("request"))
		if _, err := io.ReadFull(connection, make([]byte, 6)); err != nil {
			t.Fatal(err)
		}
	}
	closed := func(connection net.Conn) bool {
		_ = connection.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		_, err := connection.Read(make([]byte, 6))
		return err != nil && !errors.Is(err, os.ErrDeadlineExceeded)
	}

	keepalive := dial()
	answered(keepalive)
	started := time.Now()
	manager.drainForHandover(secureLinkHandoverFinish, secureLinkFinishQuiet)
	if elapsed := time.Since(started); elapsed >= secureLinkIdleQuiet {
		t.Fatalf("the answered connection was closed after %s", elapsed)
	}
	if !closed(keepalive) {
		t.Fatal("the answered connection was not closed")
	}

	justAnswered, waiting := dial(), dial()
	answered(justAnswered)
	answered(waiting)
	_, _ = waiting.Write([]byte("slow request"))
	time.Sleep(10 * time.Millisecond)
	manager.drainForHandover(secureLinkDrainTick, 0)
	if !closed(justAnswered) {
		t.Fatal("the last pass left an answered connection for the exit")
	}
	if closed(waiting) {
		t.Fatal("the last pass closed a connection waiting for its answer")
	}
}

func TestStaleTemporarySocketsAreRemoved(t *testing.T) {
	directory := t.TempDir()
	stale := directory + "/.1.7.tmp"
	own := directory + "/." + strconv.Itoa(os.Getpid()) + ".8.tmp"
	kept := directory + "/11111111-1111-4111-8111-111111111111.sock"
	for _, path := range []string{stale, own, kept} {
		listener, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		listener.(*net.UnixListener).SetUnlinkOnClose(false)
		_ = listener.Close()
	}
	removeStaleTemporarySockets(directory)
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temporary socket kept: %v", err)
	}
	for _, path := range []string{own, kept} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s removed: %v", path, err)
		}
	}
}

// restartingRelay answers every tunnel "target endpoint is restarting" until
// the target is back, then admits it and echoes its bytes.
type restartingRelay struct {
	echoRelay
	back atomic.Bool
}

func (r *restartingRelay) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if !r.back.Load() {
		if _, err := stream.Recv(); err != nil {
			return err
		}
		return status.Error(codes.Unavailable, "target endpoint is restarting")
	}
	return r.echoRelay.OpenTunnel(stream)
}

// A connection the daemon holds for a target whose node restarts is not cut
// when the daemon itself restarts or updates meanwhile: the stopping process
// keeps it until the node registered again and answers it, while it keeps
// accepting, and only then hands its sockets over.
func TestHandoverWaitsForAConnectionHeldForARestartingTarget(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := &restartingRelay{}
	server := grpc.NewServer()
	relayv1.RegisterTunnelBrokerServer(server, relay)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	plugin := &NginxPlugin{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		relayGrants: &relayGrantStore{changed: make(chan struct{}, 1), current: &pb.SyncRelayGrantsCommand{
			Grants: []*pb.RelayGrantAssignment{{
				Role: "connect", OwnerKind: proxySecureLinkOwnerKind, OwnerId: testSecureLinkID, SchemaVersion: 2,
				Candidates: []*pb.RelayDataCandidate{poolCandidate("relay-1", relaybridge.RolePrimary)},
			}},
		}},
	}
	plugin.secureLinks = testSourceLinkManager(t, plugin.openProxySecureLink)
	statuses, err := plugin.secureLinks.sync(&pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: testSecureLinkID, Role: "source", Generation: 1, SocketOnly: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	store.Settle(time.Second)
	if kept := plugin.secureLinks.keptListeners(); kept != 1 {
		t.Fatalf("kept listeners = %d, want the link's socket", kept)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go plugin.RunRelayTargetTunnels(ctx, dialTestLane(t, listener.Addr().String()), "", "relay-1")
	waitForRelayLanes(t, plugin, 1)

	request := func() net.Conn {
		connection, err := net.DialTimeout("unix", statuses[0].SocketPath, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = connection.Close() })
		if _, err := connection.Write([]byte("ping")); err != nil {
			t.Fatal(err)
		}
		return connection
	}
	held := request()
	waitForHeld(t, plugin.secureLinks, 1)
	handedOver := make(chan time.Time, 1)
	started := time.Now()
	go func() {
		plugin.HandOverSecureLinks()
		handedOver <- time.Now()
	}()
	// The node announced its restart; it registers again only after the drain
	// and the last moment the handover gives the requests accepted last.
	time.Sleep(secureLinkHandoverDrain + secureLinkHandoverFinish + 100*time.Millisecond)
	heldMeanwhile := request()
	select {
	case <-handedOver:
		t.Fatalf("the daemon handed its sockets over while a connection was held for its target (held now %d)", plugin.secureLinks.held())
	default:
	}
	relay.back.Store(true)
	back := time.Now()
	for name, connection := range map[string]net.Conn{"held before the restart": held, "accepted meanwhile": heldMeanwhile} {
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		reply := make([]byte, 4)
		if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != "ping" {
			t.Fatalf("connection %s was not answered once its target was back: %q %v", name, reply, err)
		}
	}
	select {
	case at := <-handedOver:
		if at.Before(back) || at.Sub(started) > secureLinkRestartHold {
			t.Fatalf("handed over %s after the start, the target was back after %s", at.Sub(started), back.Sub(started))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the handover did not finish once no connection was held")
	}
}

// The wait for held connections is bounded: a target that does not come back
// within the restart hold does not keep the daemon from restarting.
func TestHandoverWaitForHeldConnectionsIsBounded(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	release := make(chan struct{})
	defer close(release)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		secureLinkHolding(connection, true)
		<-release
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	store.Settle(time.Second)
	connection, err := net.DialTimeout("unix", statuses[0].SocketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, _ = connection.Write([]byte("ping"))
	waitForHeld(t, manager, 1)
	plugin := &NginxPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), secureLinks: manager}
	defer func(hold time.Duration) { secureLinkRestartHold = hold }(secureLinkRestartHold)
	secureLinkRestartHold = secureLinkHandoverDrain + 500*time.Millisecond
	started := time.Now()
	plugin.HandOverSecureLinks()
	if elapsed := time.Since(started); elapsed < secureLinkRestartHold || elapsed > secureLinkRestartHold+secureLinkHandoverFinish+200*time.Millisecond {
		t.Fatalf("handover took %s with a connection held past the restart hold of %s", elapsed, secureLinkRestartHold)
	}
}

func waitForHeld(t *testing.T, manager *sourceLinkManager, count int) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if manager.held() == count {
			return
		}
	}
	t.Fatalf("held connections = %d, want %d", manager.held(), count)
}
