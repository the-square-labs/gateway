package lifecycle

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
)

// A relay with a transport is timed on it; one without is timed by a TCP
// handshake, and a relay without an address by Gateway's control address.
func TestProbeRelayLatenciesMeasuresEveryRelay(t *testing.T) {
	relayListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	go func() { _ = server.Serve(relayListener) }()
	defer server.Stop()
	plainListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer plainListener.Close()
	go func() {
		for {
			conn, acceptErr := plainListener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	conn, err := grpc.NewClient(relayListener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Connect()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for state := conn.GetState(); state != connectivity.Ready; state = conn.GetState() {
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatal("transport never became ready")
		}
	}
	transports := &relayTransports{conns: map[string]*grpc.ClientConn{"with-transport": conn}}
	tracker := relaybridge.NewLatencyTracker(time.Now)
	probeRelayLatencies(ctx, []RelayTunnelTarget{
		{ID: "with-transport"},
		{ID: "remote", Addresses: []string{"127.0.0.1:1", plainListener.Addr().String()}},
		{ID: "local"},
		{ID: "unreachable", Addresses: []string{"127.0.0.1:1"}},
	}, transports, plainListener.Addr().String(), tracker)

	for _, id := range []string{"with-transport", "remote", "local"} {
		if _, ok := tracker.RTT(id); !ok {
			t.Fatalf("%s was not measured", id)
		}
	}
	if _, ok := tracker.RTT("unreachable"); ok {
		t.Fatal("an unreachable relay got a round trip")
	}
}
