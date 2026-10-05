package docker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// miniRelay is an in-process relay broker for daemon tests: endpoints
// register with a grant whose key id names the endpoint, sources open with a
// grant whose key id names the route, and the relay bridges the two streams
// with the production relay's frame semantics (Data, HalfClose, Close and
// Error forwarded; the stream's end is passed on as HalfClose).
type miniRelay struct {
	relayv1.UnimplementedTunnelBrokerServer
	id       string
	server   *grpc.Server
	listener net.Listener
	routes   map[string]string // route id -> endpoint id

	mu       sync.Mutex
	targets  map[string]chan *relayv1.IncomingTunnel
	pending  map[string]chan acceptedTunnel
	active   int
	sessions int
}

func startMiniRelay(t *testing.T, id string, routes map[string]string) *miniRelay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := &miniRelay{id: id, listener: listener, routes: routes, targets: map[string]chan *relayv1.IncomingTunnel{},
		pending: map[string]chan acceptedTunnel{}}
	relay.server = grpc.NewServer()
	relayv1.RegisterTunnelBrokerServer(relay.server, relay)
	go relay.server.Serve(listener)
	t.Cleanup(relay.server.Stop)
	return relay
}

func (r *miniRelay) activeTunnels() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active
}

func (r *miniRelay) RegisterEndpoint(stream relayv1.TunnelBroker_RegisterEndpointServer) error {
	first, err := stream.Recv()
	if err != nil || first.GetRegister() == nil {
		return status.Error(codes.InvalidArgument, "register first")
	}
	endpointID := first.GetRegister().GetGrant().GetKeyId()
	incoming := make(chan *relayv1.IncomingTunnel, 16)
	r.mu.Lock()
	r.targets[endpointID] = incoming
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		if r.targets[endpointID] == incoming {
			delete(r.targets, endpointID)
		}
		r.mu.Unlock()
	}()
	if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Registered{Registered: &relayv1.EndpointRegistered{EndpointId: endpointID}}}); err != nil {
		return err
	}
	renewals := make(chan error, 1)
	go func() {
		for {
			message, err := stream.Recv()
			if err != nil {
				renewals <- err
				return
			}
			if message.GetRenew() != nil {
				_ = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Registered{Registered: &relayv1.EndpointRegistered{EndpointId: endpointID}}})
			}
		}
	}()
	for {
		select {
		case err := <-renewals:
			return err
		case tunnel := <-incoming:
			if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Incoming{Incoming: tunnel}}); err != nil {
				return err
			}
		}
	}
}

func (r *miniRelay) OpenTunnel(stream relayv1.TunnelBroker_OpenTunnelServer) error {
	first, err := stream.Recv()
	if err != nil || first.GetOpen() == nil {
		return status.Error(codes.InvalidArgument, "open first")
	}
	routeID := strings.TrimPrefix(first.GetOpen().GetGrant().GetKeyId(), "route:")
	r.mu.Lock()
	incoming := r.targets[r.routes[routeID]]
	r.sessions++
	token := fmt.Sprintf("%s-%d", r.id, r.sessions)
	accepted := make(chan acceptedTunnel, 1)
	r.pending[token] = accepted
	r.mu.Unlock()
	if incoming == nil {
		return status.Error(codes.Unavailable, "target endpoint is not registered")
	}
	incoming <- &relayv1.IncomingTunnel{SessionId: token, AcceptToken: token,
		Route: &relayv1.IncomingTunnelRoute{RouteId: routeID, RouteGeneration: 1, SourceKind: "daemon", SourceId: "node-source", AssignmentGeneration: 1}}
	var tunnel acceptedTunnel
	select {
	case tunnel = <-accepted:
	case <-time.After(5 * time.Second):
		return status.Error(codes.DeadlineExceeded, "target did not accept")
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	target := tunnel.stream
	// The target's handler ends with the bridge.
	defer close(tunnel.done)
	ready := &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 1 << 20}}}
	if err := target.Send(ready); err != nil {
		return err
	}
	if err := stream.Send(ready); err != nil {
		return err
	}
	r.mu.Lock()
	r.active++
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.active--
		r.mu.Unlock()
	}()
	done := make(chan error, 2)
	go func() { done <- miniPump(target, stream) }()
	go func() { done <- miniPump(stream, target) }()
	// As the relay's bridge: a direction ends with HalfClose, the tunnel with
	// Close, Error or a failed stream.
	for finished := 0; finished < 2; finished++ {
		if err := <-done; err == errTunnelClosed {
			return nil
		} else if err != nil {
			return err
		}
	}
	return nil
}

type acceptedTunnel struct {
	stream relayv1.TunnelBroker_AcceptTunnelServer
	done   chan struct{}
}

func (r *miniRelay) AcceptTunnel(stream relayv1.TunnelBroker_AcceptTunnelServer) error {
	first, err := stream.Recv()
	if err != nil || first.GetAccept() == nil {
		return status.Error(codes.InvalidArgument, "accept first")
	}
	r.mu.Lock()
	accepted := r.pending[first.GetAccept().GetAcceptToken()]
	delete(r.pending, first.GetAccept().GetAcceptToken())
	r.mu.Unlock()
	if accepted == nil {
		return status.Error(codes.NotFound, "unknown accept token")
	}
	done := make(chan struct{})
	accepted <- acceptedTunnel{stream: stream, done: done}
	select {
	case <-done:
	case <-stream.Context().Done():
	}
	return nil
}

type miniStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

var errTunnelClosed = errors.New("tunnel closed")

// miniPump forwards one direction as the relay's pump does.
func miniPump(destination, source miniStream) error {
	for {
		frame, err := source.Recv()
		if err == io.EOF {
			return destination.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
		}
		if err != nil {
			return status.Error(codes.Unavailable, "peer stream failed")
		}
		if err := destination.Send(frame); err != nil {
			return err
		}
		if frame.GetClose() != nil || frame.GetError() != nil {
			return errTunnelClosed
		}
		if frame.GetHalfClose() != nil {
			return nil
		}
	}
}

// streamPair is a source daemon and a target daemon joined by mini relays.
type streamPair struct {
	t       *testing.T
	relays  map[string]*miniRelay
	source  *DockerPlugin
	target  *DockerPlugin
	dials   atomic.Int64
	backend net.Listener
	cancels map[*DockerPlugin]map[string]context.CancelFunc
}

const (
	testRouteID    = "3b9d6a6e-8c51-4a51-9b0e-6b2f1c7e9d10"
	testLinkID     = "8f0e4a2c-1d3b-4c5e-9f7a-2b4c6d8e0f13"
	testEndpointID = "endpoint-1"
)

var testResumeKey = bytes.Repeat([]byte{0x42}, relayresume.KeyLen)

func candidateFor(relay, state string, deadline int64, grantKey string) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{PoolId: "pool", RelayInstanceId: relay, AssignmentGeneration: 1, Capabilities: []string{relaybridge.PoolCapability},
		Grant: &pb.RelaySignedGrant{KeyId: grantKey, Payload: []byte("{}"), Signature: []byte("s")}, AssignmentState: state, DrainDeadlineUnixMs: deadline}
}

// bundles builds the source and target bundles. states: relay -> candidate state.
func testBundles(revision uint64, states map[string]string, sourceResumable, targetResumable bool) (*pb.SyncRelayGrantsCommand, *pb.SyncRelayGrantsCommand) {
	var connectCandidates, endpointCandidates []*pb.RelayDataCandidate
	for _, relay := range []string{"relay-a", "relay-b"} {
		state, ok := states[relay]
		if !ok {
			continue
		}
		connectCandidates = append(connectCandidates, candidateFor(relay, state, 0, "route:"+testRouteID))
		endpointCandidates = append(endpointCandidates, candidateFor(relay, state, 0, testEndpointID))
	}
	connect := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: containerLinkOwnerKind, OwnerId: testLinkID, RouteId: testRouteID,
		TargetEndpointId: testEndpointID, SchemaVersion: 2, Candidates: connectCandidates,
		Grant: &pb.RelaySignedGrant{KeyId: "route:" + testRouteID, Payload: []byte("{}"), Signature: []byte("s")}}
	if sourceResumable {
		connect.StreamResume = &pb.RelayStreamResume{Version: 1, KeyId: "v1", Key: testResumeKey}
	}
	endpoint := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: containerLinkOwnerKind, OwnerId: testLinkID, EndpointId: testEndpointID,
		SchemaVersion: 2, Candidates: endpointCandidates, Grant: &pb.RelaySignedGrant{KeyId: testEndpointID, Payload: []byte("{}"), Signature: []byte("s")}}
	if targetResumable {
		endpoint.ResumeRoutes = []*pb.RelayRouteResume{{RouteId: testRouteID, Version: 1, KeyId: "v1", Key: testResumeKey}}
	}
	now := time.Now().UnixMilli()
	return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, GeneratedAtUnixMs: now, Grants: []*pb.RelayGrantAssignment{connect}},
		&pb.SyncRelayGrantsCommand{PolicyRevision: revision, GeneratedAtUnixMs: now, Grants: []*pb.RelayGrantAssignment{endpoint}}
}

func newStreamPair(t *testing.T, sourceResumable, targetResumable bool) *streamPair {
	t.Helper()
	pair := &streamPair{t: t, relays: map[string]*miniRelay{}, cancels: map[*DockerPlugin]map[string]context.CancelFunc{}}
	routes := map[string]string{testRouteID: testEndpointID}
	for _, id := range []string{"relay-a", "relay-b"} {
		pair.relays[id] = startMiniRelay(t, id, routes)
	}
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pair.backend = backend
	t.Cleanup(func() { backend.Close() })
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
				_ = conn.(*net.TCPConn).CloseWrite()
			}()
		}
	}()
	sourceBundle, targetBundle := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, sourceResumable, targetResumable)
	pair.source = pair.newDaemon(sourceBundle)
	pair.target = pair.newDaemon(targetBundle)
	pair.target.endpointDialer = func(ctx context.Context, _ *pb.RelayGrantAssignment) (dialedEndpoint, error) {
		pair.dials.Add(1)
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", backend.Addr().String())
		return dialedEndpoint{conn: conn}, err
	}
	for id := range pair.relays {
		pair.connect(pair.target, id)
		pair.connect(pair.source, id)
	}
	pair.waitRegistered()
	return pair
}

func (pair *streamPair) newDaemon(bundle *pb.SyncRelayGrantsCommand) *DockerPlugin {
	logger, output := newTestLogger()
	name := fmt.Sprintf("daemon %d", len(pair.cancels))
	pair.t.Cleanup(func() {
		if pair.t.Failed() {
			output.mu.Lock()
			pair.t.Logf("%s log:\n%s", name, output.buf.String())
			output.mu.Unlock()
		}
	})
	plugin := NewDockerPlugin(&config.Config{})
	plugin.logger = logger
	store, err := newRelayGrantStore(pair.t.TempDir())
	if err != nil {
		pair.t.Fatal(err)
	}
	if err := store.sync(bundle); err != nil {
		pair.t.Fatal(err)
	}
	plugin.relayGrants = store
	pair.cancels[plugin] = map[string]context.CancelFunc{}
	return plugin
}

// connect runs the daemon's tunnels to one relay (as the relay pool does).
func (pair *streamPair) connect(plugin *DockerPlugin, relayID string) {
	conn, err := grpc.NewClient(pair.relays[relayID].listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		pair.t.Fatal(err)
	}
	conn.Connect()
	ctx, cancel := context.WithCancel(context.Background())
	pair.cancels[plugin][relayID] = cancel
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.RunRelayTargetTunnels(ctx, conn, "", relayID)
	}()
	pair.t.Cleanup(func() {
		cancel()
		<-done
		conn.Close()
	})
}

func (pair *streamPair) waitRegistered() {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ready := true
		for _, relay := range pair.relays {
			relay.mu.Lock()
			_, ok := relay.targets[testEndpointID]
			relay.mu.Unlock()
			ready = ready && ok
		}
		if ready && pair.source.relayRouter("relay-a") != nil && pair.source.relayRouter("relay-b") != nil &&
			pair.source.relayRouter("relay-a").connected() && pair.source.relayRouter("relay-b").connected() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	pair.t.Fatal("endpoint registrations did not come up")
}

// open opens a source stream like the egress socket does and returns the
// application's end.
func (pair *streamPair) open() (net.Conn, *relaySourceTunnel) {
	assignment := pair.source.relayGrants.lookup("connect", containerLinkOwnerKind, testLinkID)
	tunnel, err := pair.source.openRelaySource(assignment)
	if err != nil {
		pair.t.Fatal(err)
	}
	local, app := testTCPPair(pair.t)
	go tunnel.bridge(local)
	return app, tunnel
}

func testTCPPair(t *testing.T) (net.Conn, net.Conn) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	app, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	local, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	return local, app
}

// echoThrough writes size random bytes, runs during part way, and checks the
// echo is exact.
func echoThrough(t *testing.T, app net.Conn, size int, during func()) {
	t.Helper()
	data := make([]byte, size)
	rng := rand.New(rand.NewPCG(7, 9))
	for i := range data {
		data[i] = byte(rng.Uint32())
	}
	got := make(chan []byte, 1)
	var readErr, writeErr error
	go func() {
		received, err := io.ReadAll(app)
		readErr = err
		got <- received
	}()
	go func() {
		for off := 0; off < len(data); {
			n := min(len(data)-off, 1+rng.IntN(48*1024))
			if _, err := app.Write(data[off : off+n]); err != nil {
				writeErr = err
				return
			}
			off += n
			if during != nil && off > len(data)/3 {
				during()
				during = nil
			}
		}
		_ = app.(*net.TCPConn).CloseWrite()
	}()
	select {
	case received := <-got:
		if sha256.Sum256(received) != sha256.Sum256(data) {
			t.Fatalf("echo differs: %d of %d bytes (read error %v, write error %v)", len(received), len(data), readErr, writeErr)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("echo timed out")
	}
}

// echoExact checks a raw stream: the application reads the whole echo before
// it closes. A raw tunnel's end races its last frames (the endpoint cancels
// its stream right after its Close frame, and gRPC may drop what the relay
// had not read yet), which this test is not about.
func echoExact(t *testing.T, app net.Conn, size int) {
	t.Helper()
	data := make([]byte, size)
	rng := rand.New(rand.NewPCG(3, 5))
	for i := range data {
		data[i] = byte(rng.Uint32())
	}
	go func() { _, _ = app.Write(data) }()
	received := make([]byte, size)
	_ = app.SetReadDeadline(time.Now().Add(30 * time.Second))
	if _, err := io.ReadFull(app, received); err != nil || !bytes.Equal(received, data) {
		t.Fatalf("raw echo: %v", err)
	}
	_ = app.Close()
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestResumableLinkStreamEchoes(t *testing.T) {
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	if tunnel.session == nil {
		t.Fatal("stream is not resumable")
	}
	echoThrough(t, app, 2<<20, nil)
	waitFor(t, "the stream to finish", func() bool { return tunnel.session.State() == relayresume.StateFinished })
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
}

// A drain in the source's bundle moves the stream to the other relay without
// a second backend dial, and the drained relay ends up with no tunnel.
func TestResumableLinkStreamMovesOffDrainingRelay(t *testing.T) {
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	first := tunnel.session.RelayID()
	other := "relay-b"
	if first == "relay-b" {
		other = "relay-a"
	}
	echoThrough(t, app, 6<<20, func() {
		sourceBundle, _ := testBundles(2, map[string]string{first: "draining", other: "active"}, true, true)
		if _, err := pair.source.SyncRelayGrants(sourceBundle); err != nil {
			t.Error(err)
			return
		}
		waitFor(t, "the stream to move", func() bool { return tunnel.session.RelayID() == other })
		waitFor(t, "the drained relay to end its tunnel", func() bool { return pair.relays[first].activeTunnels() == 0 })
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	stats := pair.source.relayStreamStats()
	if stats.GetMigrationsOkTotal() == 0 {
		t.Fatalf("stats %+v", stats)
	}
}

// A relay that dies takes no stream with it: the stream resumes on the other.
func TestResumableLinkStreamSurvivesRelayLoss(t *testing.T) {
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	echoThrough(t, app, 6<<20, func() {
		pair.relays[tunnel.session.RelayID()].server.Stop()
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
}

// A relay that stops gracefully (GOAWAY) moves its streams at once.
func TestResumableLinkStreamMovesOnGoAway(t *testing.T) {
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	var stopping *miniRelay
	echoThrough(t, app, 6<<20, func() {
		relayID := tunnel.session.RelayID()
		stopping = pair.relays[relayID]
		go stopping.server.GracefulStop()
		// The relay pool reports the lane leaving READY (lifecycle.RelayLaneStatePlugin).
		pair.source.RelayLaneLeftReady(relayID, pair.source.relayRouter(relayID).conn)
		waitFor(t, "the stream to leave the stopping relay", func() bool {
			moved := tunnel.session.RelayID()
			return moved != "" && moved != relayID
		})
	})
	// Its endpoint registrations stay until the relay stops for good; its
	// tunnels are gone.
	waitFor(t, "the stopping relay to end its tunnels", func() bool { return stopping.activeTunnels() == 0 })
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
}

// A target without the route in its resume list serves the raw stream; the
// source finds out from the first answer, resets that stream and opens raw
// tunnels for the route from then on.
func TestResumableSourceFallsBackToRawTarget(t *testing.T) {
	pair := newStreamPair(t, true, false)
	app, tunnel := pair.open()
	if tunnel.session == nil {
		t.Fatal("first stream is not resumable")
	}
	_, _ = app.Write([]byte("hello"))
	waitFor(t, "the stream to reset", func() bool { return tunnel.session.State() == relayresume.StateReset })
	if !errors.Is(tunnel.session.Err(), relayresume.ErrLegacyPeer) {
		t.Fatalf("err %v", tunnel.session.Err())
	}
	waitFor(t, "the route to be latched raw", func() bool { return pair.source.relayStreams().sources.Legacy(testRouteID) })
	app2, tunnel2 := pair.open()
	if tunnel2.session != nil {
		t.Fatal("latched route opened a resumable stream")
	}
	echoExact(t, app2, 64*1024)
}

// A source without the flag reaches a target that has it: the first-record
// rule serves the raw stream as before.
func TestRawSourceReachesResumableTarget(t *testing.T) {
	pair := newStreamPair(t, false, true)
	app, tunnel := pair.open()
	if tunnel.session != nil {
		t.Fatal("unflagged route opened a resumable stream")
	}
	echoExact(t, app, 1<<20)
}

// A route Gateway no longer assigns ends its resumable streams.
func TestResumableSourceEndsWhenRouteRevoked(t *testing.T) {
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	_, _ = app.Write([]byte("x"))
	if _, err := io.ReadFull(app, make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pair.source.SyncRelayGrants(&pb.SyncRelayGrantsCommand{PolicyRevision: 3, GeneratedAtUnixMs: time.Now().UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the stream to end", func() bool { return tunnel.session.State() == relayresume.StateReset })
	if !errors.Is(tunnel.session.Err(), relayresume.ErrAborted) && !strings.Contains(fmt.Sprint(tunnel.session.Err()), "no longer assigned") {
		t.Fatalf("err %v", tunnel.session.Err())
	}
}
