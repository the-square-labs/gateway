package lifecycle

import (
	"context"
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// grantSyncWorker applies relay grant bundles off the session's receive loop, one at a time. A grant sync can take
// seconds (database link listeners, the connector's egress); run inline, it held every other command of the session
// back, and Gateway's command timeouts expired one after the other (S6). Bundles that arrive while one is applied
// collapse into the newest of them, and every one of those commands is answered with its result.
type grantSyncWorker struct {
	ctx  context.Context
	run  func(*pb.SyncRelayGrantsCommand) (string, error)
	send func(*pb.CommandResult)

	mu      sync.Mutex
	pending []*pb.GatewayCommand
	running bool
}

func newGrantSyncWorker(ctx context.Context, run func(*pb.SyncRelayGrantsCommand) (string, error), send func(*pb.CommandResult)) *grantSyncWorker {
	return &grantSyncWorker{ctx: ctx, run: run, send: send}
}

// submit queues a grant sync command and returns at once.
func (w *grantSyncWorker) submit(command *pb.GatewayCommand) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = append(w.pending, command)
	if !w.running {
		w.running = true
		go w.loop()
	}
}

func (w *grantSyncWorker) loop() {
	for {
		w.mu.Lock()
		batch := w.pending
		w.pending = nil
		if len(batch) == 0 || w.ctx.Err() != nil {
			w.running = false
			w.mu.Unlock()
			return
		}
		w.mu.Unlock()
		detail, err := w.run(newestGrantBundle(batch))
		for _, command := range batch {
			result := &pb.CommandResult{CommandId: command.CommandId, Success: err == nil, Detail: detail}
			if err != nil {
				result.Detail, result.Error = "", err.Error()
			}
			w.send(result)
		}
	}
}

// newestGrantBundle is the bundle of the batch with the highest policy revision and creation time, the latest one
// on a tie: an older bundle arriving last must not replace a newer one (the grant store refuses it).
func newestGrantBundle(batch []*pb.GatewayCommand) *pb.SyncRelayGrantsCommand {
	var newest *pb.SyncRelayGrantsCommand
	for _, command := range batch {
		bundle := command.GetSyncRelayGrants()
		if newest == nil || bundle.GetPolicyRevision() > newest.GetPolicyRevision() ||
			(bundle.GetPolicyRevision() == newest.GetPolicyRevision() && bundle.GetGeneratedAtUnixMs() >= newest.GetGeneratedAtUnixMs()) {
			newest = bundle
		}
	}
	return newest
}
