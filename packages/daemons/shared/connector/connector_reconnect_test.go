package connector

import (
	"context"
	"math"
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
)

// relayRestartFailedAttempts is how many reconnect attempts fail while the relay is away before it listens again.
const relayRestartFailedAttempts = 3

// TestReconnectParamsBringALaneBackRightAfterARelayRestart is C-3: a relay restart (an update recreates the local
// relay) drops every lane's transport; the lanes keep their ClientConn and grpc reconnects them on its own. The relay
// comes back after a few failed reconnect attempts; grpc then waits out its current backoff before trying again. With
// grpc's default backoff (1 s growing by 1.6) that wait is already more than 2 s after the third failure; the lane
// must be ready well before the earliest moment the default backoff could even try again.
//
// The relay is counted down in failed attempts rather than a fixed outage: after a wall-clock outage the lane could
// have failed just before the relay came back and be anywhere inside its current backoff, which made the time to
// ready depend on that phase instead of the backoff configured here.
func TestReconnectParamsBringALaneBackRightAfterARelayRestart(t *testing.T) {
	var relayAddress atomic.Pointer[string]
	failedAttempts := make(chan time.Time, 64)
	dialRelay := func(ctx context.Context, _ string) (net.Conn, error) {
		address := relayAddress.Load()
		if address == nil {
			select {
			case failedAttempts <- time.Now():
			default:
			}
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
		var dialer net.Dialer
		return dialer.DialContext(ctx, "tcp", *address)
	}
	listenRelay := func() *grpc.Server {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		relay := grpc.NewServer()
		go func() { _ = relay.Serve(listener) }()
		address := listener.Addr().String()
		relayAddress.Store(&address)
		return relay
	}

	relay := listenRelay()
	conn, err := grpc.NewClient("passthrough:///relay",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(dialRelay),
		grpc.WithConnectParams(ReconnectParams))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := waitUntilReady(ctx, conn); err != nil {
		t.Fatalf("first connect: %v", err)
	}

	relayAddress.Store(nil)
	relay.Stop()
	// The lane's registrations keep retrying while the relay is away, which keeps grpc connecting.
	laneCtx, stopLane := context.WithCancel(ctx)
	defer stopLane()
	go func() {
		for state := conn.GetState(); ; state = conn.GetState() {
			if state == connectivity.Idle {
				conn.Connect()
			}
			if !conn.WaitForStateChange(laneCtx, state) {
				return
			}
		}
	}()
	var lastFailure time.Time
	for failures := 0; failures < relayRestartFailedAttempts; failures++ {
		select {
		case lastFailure = <-failedAttempts:
		case <-ctx.Done():
			t.Fatalf("grpc made %d reconnect attempts while the relay was away, want %d", failures, relayRestartFailedAttempts)
		}
	}

	next := listenRelay()
	defer next.Stop()
	if err := waitUntilReady(ctx, conn); err != nil {
		t.Fatalf("the lane did not reconnect: %v", err)
	}
	elapsed := time.Since(lastFailure)
	// grpc starts the backoff timer only after an attempt failed, so with its defaults the next attempt cannot come
	// before this bound, however fast the machine is; the configured backoff is several times shorter.
	defaultEarliest := backoffLowerBound(backoff.DefaultConfig, relayRestartFailedAttempts-1)
	if elapsed >= defaultEarliest {
		t.Fatalf("lane ready %s after its last failed attempt, want within the configured backoff (at most %s), well before grpc's default backoff could retry (%s)",
			elapsed, backoffUpperBound(ReconnectParams.Backoff, relayRestartFailedAttempts-1), defaultEarliest)
	}
}

// backoffLowerBound and backoffUpperBound bound grpc's wait before the reconnect attempt that follows retries+1
// consecutive failures.
func backoffLowerBound(config backoff.Config, retries int) time.Duration {
	return time.Duration(float64(config.BaseDelay) * math.Pow(config.Multiplier, float64(retries)) * (1 - config.Jitter))
}

func backoffUpperBound(config backoff.Config, retries int) time.Duration {
	return time.Duration(float64(config.BaseDelay) * math.Pow(config.Multiplier, float64(retries)) * (1 + config.Jitter))
}
