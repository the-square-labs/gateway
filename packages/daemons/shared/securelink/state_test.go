package securelink

import (
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func stateCommand(id string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{LinkId: id}}}
}

func TestStateStoreStagesWithoutReplacingCommittedState(t *testing.T) {
	store, err := NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	committed := stateCommand("11111111-1111-4111-8111-111111111111")
	pending := stateCommand("22222222-2222-4222-8222-222222222222")
	if err := store.Commit(committed); err != nil {
		t.Fatal(err)
	}
	if err := store.Stage(pending); err != nil {
		t.Fatal(err)
	}
	if !store.HasPending() {
		t.Fatal("expected pending marker")
	}
	staged, exists, err := store.Pending()
	if err != nil || !exists || staged.Bindings[0].LinkId != pending.Bindings[0].LinkId {
		t.Fatalf("pending state = %#v exists=%v err=%v", staged, exists, err)
	}
	reopened, err := NewStateStore(filepath.Dir(store.path))
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Bindings[0].LinkId; got != committed.Bindings[0].LinkId {
		t.Fatalf("restart restored pending state %s", got)
	}
}

func TestStateStoreCommitPromotesAndClearsPendingState(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	next := stateCommand("22222222-2222-4222-8222-222222222222")
	if err := store.Stage(next); err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(next); err != nil {
		t.Fatal(err)
	}
	if store.HasPending() {
		t.Fatal("pending marker survived commit")
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Bindings[0].LinkId; got != next.Bindings[0].LinkId {
		t.Fatalf("committed state = %s", got)
	}
}

func TestStateStorePersistsSourceConfigOwnershipIndependentlyOfListenerState(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	command := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: "11111111-1111-4111-8111-111111111111", Role: "source", ListenerPort: 41000,
	}}}
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}
	previous, found, err := store.SetSourceConfigManaged(command.Bindings[0].LinkId, true)
	if err != nil || !found || previous {
		t.Fatalf("ownership update previous=%v found=%v err=%v", previous, found, err)
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.Get().Bindings[0]
	if !got.SourceConfigManaged || got.ListenerPort != 41000 {
		t.Fatalf("persisted binding = %#v", got)
	}
}
