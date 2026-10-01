package docker

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testStorageBindingID = "5b0c3b52-5d0f-4c1c-9a59-3f8f0f4c2a11"

// fakeTunnelBroker is a relay whose OpenTunnel answers with open.
type fakeTunnelBroker struct {
	relayv1.TunnelBrokerClient
	open func() *fakeSourceStream
}

func (f *fakeTunnelBroker) OpenTunnel(context.Context, ...grpc.CallOption) (grpc.BidiStreamingClient[relayv1.TunnelFrame, relayv1.TunnelFrame], error) {
	return f.open(), nil
}

// fakeSourceStream answers the open frame with first (after admit closes, when set), then ends the tunnel.
type fakeSourceStream struct {
	grpc.ClientStream
	admit   chan struct{}
	first   *relayv1.TunnelFrame
	refusal error
	sent    chan *relayv1.TunnelFrame
	recvs   int
}

func (s *fakeSourceStream) Send(frame *relayv1.TunnelFrame) error {
	select {
	case s.sent <- frame:
	default:
	}
	return nil
}

func (s *fakeSourceStream) Recv() (*relayv1.TunnelFrame, error) {
	s.recvs++
	if s.recvs > 1 {
		return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, nil
	}
	if s.admit != nil {
		<-s.admit
	}
	if s.refusal != nil {
		return nil, s.refusal
	}
	return s.first, nil
}

func readyFrame() *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 16 * 1024}}}
}

func newRelayTestPlugin(t *testing.T, broker *fakeTunnelBroker, assignments ...*pb.RelayGrantAssignment) (*DockerPlugin, *lockedLog) {
	t.Helper()
	logger, output := newTestLogger()
	plugin := &DockerPlugin{logger: logger, relayGrants: &relayGrantStore{current: &pb.SyncRelayGrantsCommand{Grants: assignments}, changed: make(chan struct{}, 1)}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	plugin.relayTunnels = map[string]*relayTunnelRouter{
		relaybridge.LegacyTargetID: {plugin: plugin, ctx: ctx, client: broker, targetID: relaybridge.LegacyTargetID, registrations: map[string]*relayEndpointRegistration{}},
	}
	return plugin, output
}

func connectAssignment(ownerKind, ownerID string) *pb.RelayGrantAssignment {
	payload, _ := json.Marshal(map[string]any{"kind": "connect", "maxConcurrentSessions": 64})
	return &pb.RelayGrantAssignment{Role: "connect", OwnerKind: ownerKind, OwnerId: ownerID,
		Grant: &pb.RelaySignedGrant{KeyId: "key-1", Payload: payload, Signature: []byte("signature")}}
}

// A binding at its relay session limit: the relay refuses the tunnel, and the daemon says which binding and why
// instead of closing the client's connection silently.
func TestManagedDatabaseBindingLogsTheRelayRefusal(t *testing.T) {
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{refusal: status.Error(codes.ResourceExhausted, "relay route session capacity reached"), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, output := newRelayTestPlugin(t, broker, connectAssignment("managed_database_binding", testListenerBindingA))
	for range 3 {
		client, daemonSide := net.Pipe()
		plugin.openManagedDatabaseBinding(daemonSide, testListenerBindingA, 0)
		_ = daemonSide.Close()
		_ = client.Close()
	}
	lines := output.lines("level=WARN", "managed link connection rejected", "binding_id="+testListenerBindingA,
		"reason="+linkRejectedRelayCapacity, `error="relay route session capacity reached"`)
	if len(lines) != 1 || len(output.lines("connection rejected")) != 1 {
		t.Fatalf("relay refusal logged %q", output.lines("rejected"))
	}
}

// The storage connector hears "ready" only once the relay admitted the tunnel; a capacity refusal reaches it as an
// error it can report.
func TestStorageConnectorRelayAnswersOnceTheTunnelIsOpen(t *testing.T) {
	admit := make(chan struct{})
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{admit: admit, first: readyFrame(), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, _ := newRelayTestPlugin(t, broker, connectAssignment(storageBindingOwnerKind, testStorageBindingID))
	connector, daemonSide := net.Pipe()
	defer connector.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.handleStorageConnectorRelay(daemonSide)
	}()
	if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.ProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: testStorageBindingID}); err != nil {
		t.Fatal(err)
	}
	answered := make(chan securelink.RelayResponse, 1)
	go func() {
		var response securelink.RelayResponse
		if err := securelink.ReadJSON(connector, &response); err == nil {
			answered <- response
		}
	}()
	select {
	case response := <-answered:
		t.Fatalf("connector answered before the relay admitted the tunnel: %+v", response)
	case <-time.After(150 * time.Millisecond):
	}
	close(admit)
	select {
	case response := <-answered:
		if response.Error != "" {
			t.Fatalf("admitted tunnel answered with %q", response.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connector not answered after the relay admitted the tunnel")
	}
	// The relay ends the tunnel; the daemon closes the connector's connection.
	_, _ = io.Copy(io.Discard, connector)
	<-done
}

func TestStorageConnectorRelayReportsTheCapacityRefusal(t *testing.T) {
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{refusal: status.Error(codes.ResourceExhausted, "relay route session capacity reached"), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, output := newRelayTestPlugin(t, broker, connectAssignment(storageBindingOwnerKind, testStorageBindingID))
	connector, daemonSide := net.Pipe()
	defer connector.Close()
	go plugin.handleStorageConnectorRelay(daemonSide)
	if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.ProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: testStorageBindingID}); err != nil {
		t.Fatal(err)
	}
	var response securelink.RelayResponse
	if err := securelink.ReadJSON(connector, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "storage link session capacity reached: relay route session capacity reached" {
		t.Fatalf("refusal answered with %q", response.Error)
	}
	if lines := output.lines("level=WARN", "binding_id="+testStorageBindingID, "reason="+linkRejectedRelayCapacity); len(lines) != 1 {
		t.Fatalf("storage refusal logged %q", output.lines("rejected"))
	}
	if !strings.Contains(output.lines("rejected")[0], "owner_kind="+storageBindingOwnerKind) {
		t.Fatalf("storage refusal without its owner kind: %q", output.lines("rejected"))
	}
}
