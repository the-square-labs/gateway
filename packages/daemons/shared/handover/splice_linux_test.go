//go:build linux

package handover

import (
	"bytes"
	"crypto/rand"
	"io"
	"testing"
	"time"
)

// pipeTransfer moves data one way through a node-local pipe between a TCP and
// a Unix socket pair and returns what arrived; idle, if set, runs while the
// pipe is open and idle after the data.
func pipeTransfer(t *testing.T, data []byte, idle func()) []byte {
	t.Helper()
	client, left := benchPair(t, false)
	right, server := benchPair(t, true)
	done := make(chan error, 1)
	go func() { done <- (*Registry)(nil).Pipe(left, right, PipeConfig{}) }()
	go func() { _, _ = client.Write(data) }()
	got := make([]byte, len(data))
	if _, err := io.ReadFull(server, got); err != nil {
		t.Fatal(err)
	}
	if idle != nil {
		idle()
	}
	_ = client.(interface{ CloseWrite() error }).CloseWrite()
	_ = server.(interface{ CloseWrite() error }).CloseWrite()
	if _, err := io.Copy(io.Discard, server); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	_ = server.Close()
	return got
}

// A transfer holds a pipe only while bytes flow: an idle connection holds none
// (stand rc.10 F-2: two pipes per connection for its life spent the user's
// pipe budget, and the kernel then gave every new pipe two pages).
func TestSplicePipesAreHeldOnlyWhileBytesFlow(t *testing.T) {
	drainPipes()
	data := make([]byte, 8<<20)
	_, _ = rand.Read(data)
	inUse := -1
	got := pipeTransfer(t, data, func() {
		time.Sleep(50 * time.Millisecond)
		splicePipes.Lock()
		inUse = splicePipes.open - len(splicePipes.free)
		splicePipes.Unlock()
	})
	if !bytes.Equal(got, data) {
		t.Fatal("bytes differ")
	}
	if inUse != 0 {
		t.Fatalf("an idle pipe holds %d kernel pipes", inUse)
	}
}

// When the system gives only small pipes (a spent per-user budget), a pipe
// copies through its buffers, byte-exact, and asks for no new pipe for a while.
func TestSmallPipesAreNotSplicedThrough(t *testing.T) {
	restore := benchMethod("splice")
	defer restore()
	splicePipeBytes = 8192
	data := make([]byte, 4<<20)
	_, _ = rand.Read(data)
	if got := pipeTransfer(t, data, nil); !bytes.Equal(got, data) {
		t.Fatal("bytes differ")
	}
	splicePipes.Lock()
	open, refused := splicePipes.open, splicePipes.refused
	splicePipes.Unlock()
	if open != 0 || refused.IsZero() {
		t.Fatalf("open %d refused %v", open, refused)
	}
	if takePipe() != nil {
		t.Fatal("a pipe right after the system refused a full-size one")
	}
}
