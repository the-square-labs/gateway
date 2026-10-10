//go:build linux

package handover

import (
	"net"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/handover/handovertest"
)

func loopbackPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return client, server
}

// A peer updated in the same batch opens a stream to this node just as it
// hands over (stand rc.13 O-a): the handover waits for the connection being
// set up, which then goes along instead of being cut with this process.
func TestHandOverTakesAConnectionThatWasBeingSetUp(t *testing.T) {
	registry := NewRegistry()
	done := registry.Setup()
	left, _ := loopbackPair(t)
	right, _ := loopbackPair(t)
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = registry.Pipe(left, right, PipeConfig{Started: done})
	}()
	result := registry.HandOver(Options{DaemonType: "docker", Version: "v1", Keeper: handovertest.NewKeeper()})
	if result.Err != nil || !result.Committed || result.HandedOver != 1 || len(result.Cut) != 0 {
		t.Fatalf("handover = %+v, want the connection set up meanwhile handed over", result)
	}
	if cut := registry.Remaining(); len(cut) != 0 {
		t.Fatalf("remaining = %v, want nothing left for the exit to cut", cut)
	}
}

// A setup that does not end within setupWait does not hold the update.
func TestHandOverWaitsForASetupOnlySoLong(t *testing.T) {
	previous := setupWait
	setupWait = 50 * time.Millisecond
	t.Cleanup(func() { setupWait = previous })
	registry := NewRegistry()
	done := registry.Setup()
	defer done()
	started := time.Now()
	result := registry.HandOver(Options{DaemonType: "docker", Version: "v1", Keeper: handovertest.NewKeeper()})
	if waited := time.Since(started); waited > time.Second {
		t.Fatalf("handover took %v, want it bounded by setupWait", waited)
	}
	if result.Err != nil || result.Committed {
		t.Fatalf("handover = %+v, want nothing to hand over", result)
	}
}

// Ending a setup twice (a bridge that registered, then its setup's deferred
// end) counts it once.
func TestSetupEndsOnce(t *testing.T) {
	registry := NewRegistry()
	first, second := registry.Setup(), registry.Setup()
	first()
	first()
	registry.mu.Lock()
	setups := registry.setups
	registry.mu.Unlock()
	if setups != 1 {
		t.Fatalf("setups = %d, want 1", setups)
	}
	second()
	var nilRegistry *Registry
	nilRegistry.Setup()()
}
