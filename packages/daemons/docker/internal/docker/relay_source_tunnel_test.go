package docker

import (
	"context"
	"encoding/json"
	"net"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
