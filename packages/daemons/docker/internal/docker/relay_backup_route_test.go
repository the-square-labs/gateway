package docker

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

type recordingTunnelBrokerClient struct {
	relayv1.TunnelBrokerClient
	grants chan string
}

func (c *recordingTunnelBrokerClient) OpenTunnel(context.Context, ...grpc.CallOption) (grpc.BidiStreamingClient[relayv1.TunnelFrame, relayv1.TunnelFrame], error) {
	return &recordingOpenStream{grants: c.grants}, nil
}

type recordingOpenStream struct {
	grpc.ClientStream
	grants chan string
}

func (s *recordingOpenStream) Send(frame *relayv1.TunnelFrame) error {
	s.grants <- frame.GetOpen().GetGrant().GetKeyId()
	return nil
}

func (s *recordingOpenStream) Recv() (*relayv1.TunnelFrame, error) {
	return nil, errors.New("closed by test")
}

// A backup keeps its loopback route open for the whole run; connections it
// opens after the grant bundle changed must use the newest grants.
func TestBackupRelayRouteUsesTheNewestGrantPerConnection(t *testing.T) {
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const runID = "3f1c2a8e-5b7d-4e2f-9a6c-1d2e3f4a5b6c"
	bundle := func(revision uint64, keyID string) *pb.SyncRelayGrantsCommand {
		return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, Grants: []*pb.RelayGrantAssignment{{
			Role: "connect", OwnerKind: "database_backup_source", OwnerId: runID,
			Grant: &pb.RelaySignedGrant{KeyId: keyID, Payload: []byte("{}"), Signature: make([]byte, 64)},
		}}}
	}
	if err := store.sync(bundle(1, "grant-before")); err != nil {
		t.Fatal(err)
	}
	grants := make(chan string, 4)
	plugin := &DockerPlugin{relayGrants: store, relayTunnels: map[string]*relayTunnelRouter{
		"local": {ctx: context.Background(), targetID: "local", client: &recordingTunnelBrokerClient{grants: grants}},
	}}
	route, err := plugin.OpenBackupRelayRoute(context.Background(), "database_backup_source", runID)
	if err != nil {
		t.Fatal(err)
	}
	defer route.cancel()

	if err := store.sync(bundle(2, "grant-after")); err != nil {
		t.Fatal(err)
	}
	connection, err := net.Dial("tcp", route.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case keyID := <-grants:
		if keyID != "grant-after" {
			t.Fatalf("connection opened with %s, want the newest grant", keyID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the backup route did not open a relay tunnel")
	}
}
