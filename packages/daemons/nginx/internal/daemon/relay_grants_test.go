package daemon

import (
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestRelayGrantStoreSignalsOnlyLaneCountChanges(t *testing.T) {
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 1, DataLanes: 4, ReadChunkBytes: 32 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, true)

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 2, DataLanes: 4, ReadChunkBytes: 64 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, false)

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 3, DataLanes: 6, ReadChunkBytes: 64 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, true)
}

func assertRelayRuntimeSignal(t *testing.T, changed <-chan struct{}, want bool) {
	t.Helper()
	select {
	case <-changed:
		if !want {
			t.Fatal("unexpected relay runtime change signal")
		}
	default:
		if want {
			t.Fatal("expected relay runtime change signal")
		}
	}
}
