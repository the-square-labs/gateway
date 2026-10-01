package server

import (
	"sync"
	"testing"
	"time"
)

// blockingServer models a gRPC server whose graceful stop waits for streams
// that never finish until the server is stopped forcefully.
type blockingServer struct {
	once     sync.Once
	forced   chan struct{}
	finishes bool
	stops    int
	mu       sync.Mutex
}

func newBlockingServer(finishes bool) *blockingServer {
	return &blockingServer{forced: make(chan struct{}), finishes: finishes}
}

func (s *blockingServer) GracefulStop() {
	if s.finishes {
		return
	}
	<-s.forced
}

func (s *blockingServer) Stop() {
	s.mu.Lock()
	s.stops++
	s.mu.Unlock()
	s.once.Do(func() { close(s.forced) })
}

func TestStopWithinForcesOpenStreamsClosedAfterDeadline(t *testing.T) {
	server := newBlockingServer(false)
	started := time.Now()
	if !stopWithin(server, 50*time.Millisecond) {
		t.Fatal("stop did not report forcing open streams closed")
	}
	if elapsed := time.Since(started); elapsed < 50*time.Millisecond || elapsed > 5*time.Second {
		t.Fatalf("forced stop took %s", elapsed)
	}
	if server.stops != 1 {
		t.Fatalf("forced stops = %d, want 1", server.stops)
	}
}

func TestStopWithinDoesNotForceWhenStreamsFinish(t *testing.T) {
	server := newBlockingServer(true)
	if stopWithin(server, time.Minute) {
		t.Fatal("stop forced a server whose streams finished")
	}
	if server.stops != 0 {
		t.Fatalf("forced stops = %d, want 0", server.stops)
	}
}
