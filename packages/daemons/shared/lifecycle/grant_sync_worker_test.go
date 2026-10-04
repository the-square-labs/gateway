package lifecycle

import (
	"context"
	"sync"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func grantSyncCommand(id string, revision uint64) *pb.GatewayCommand {
	return &pb.GatewayCommand{CommandId: id, Payload: &pb.GatewayCommand_SyncRelayGrants{
		SyncRelayGrants: &pb.SyncRelayGrantsCommand{PolicyRevision: revision},
	}}
}

// A slow grant sync (database listeners, connector egress) no longer holds the session's receive loop: submitting
// returns at once, so the commands behind it are served meanwhile (S6). Bundles that arrive while one is applied
// collapse into the newest, and every command is answered.
func TestSlowGrantSyncDoesNotHoldTheSession(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var applied []uint64
	results := make(chan *pb.CommandResult, 8)
	worker := newGrantSyncWorker(context.Background(), func(bundle *pb.SyncRelayGrantsCommand) (string, error) {
		mu.Lock()
		applied = append(applied, bundle.GetPolicyRevision())
		first := len(applied) == 1
		mu.Unlock()
		if first {
			close(started)
			<-release
		}
		return "applied", nil
	}, func(result *pb.CommandResult) { results <- result })

	submitted := make(chan struct{})
	go func() {
		worker.submit(grantSyncCommand("bundle-1", 1))
		<-started
		// The receive loop goes on with the next commands while bundle 1 is applied.
		worker.submit(grantSyncCommand("bundle-3", 3))
		worker.submit(grantSyncCommand("bundle-2", 2))
		close(submitted)
	}()
	select {
	case <-submitted:
	case <-time.After(2 * time.Second):
		t.Fatal("a slow grant sync held the receive loop")
	}
	select {
	case result := <-results:
		t.Fatalf("answered %s before the slow sync finished", result.CommandId)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)

	answered := map[string]bool{}
	for range 3 {
		select {
		case result := <-results:
			if !result.Success || result.Detail != "applied" {
				t.Fatalf("result %+v", result)
			}
			answered[result.CommandId] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("answered only %v", answered)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(applied) != 2 || applied[0] != 1 || applied[1] != 3 {
		t.Fatalf("applied revisions %v, want 1 then the newest pending (3)", applied)
	}
}
