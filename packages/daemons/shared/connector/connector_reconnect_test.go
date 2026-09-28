package connector

import (
	"context"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
)

// TestReconnectParamsBringALaneBackRightAfterARelayRestart is C-3: a relay restart (an update recreates the local
// relay) drops every lane's transport; the lanes keep their ClientConn and grpc reconnects them on its own. The relay
// is back 1.5 s later on the same address; the lane must be ready again within a few hundred ms of that, where grpc's
// default backoff (1 s growing by 1.6) would next try about 1 s later.
func TestReconnectParamsBringALaneBackRightAfterARelayRestart(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	relay := grpc.NewServer()
	go func() { _ = relay.Serve(listener) }()

	conn, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithConnectParams(ReconnectParams))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := waitUntilReady(ctx, conn); err != nil {
		t.Fatalf("first connect: %v", err)
	}

	relay.Stop()
	// The lane's registrations keep retrying while the relay is away, which keeps grpc connecting.
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if conn.GetState() == connectivity.Idle {
			conn.Connect()
		}
		time.Sleep(20 * time.Millisecond)
	}
	restarted, err := net.Listen("tcp", address)
	if err != nil {
		t.Skipf("the relay address was taken meanwhile: %v", err)
	}
	next := grpc.NewServer()
	go func() { _ = next.Serve(restarted) }()
	defer next.Stop()
	back := time.Now()

	for state := conn.GetState(); state != connectivity.Ready; state = conn.GetState() {
		if state == connectivity.Idle {
			conn.Connect()
		}
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatalf("the lane did not reconnect: %v", ctx.Err())
		}
	}
	if elapsed := time.Since(back); elapsed > time.Second {
		t.Fatalf("lane ready %s after the relay listened again, want a few hundred ms", elapsed)
	}
}
