package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type relayGrantStore struct {
	path    string
	mu      sync.RWMutex
	current *pb.SyncRelayGrantsCommand
	changed chan struct{}
}

func newRelayGrantStore(stateDir string) (*relayGrantStore, error) {
	store := &relayGrantStore{path: filepath.Join(stateDir, "relay-grants.json"), current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1)}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err := protojson.Unmarshal(data, store.current); err != nil {
		return nil, fmt.Errorf("decode relay grants: %w", err)
	}
	return store, nil
}

func (s *relayGrantStore) sync(command *pb.SyncRelayGrantsCommand) error {
	if command == nil {
		return errors.New("relay grant bundle is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if command.PolicyRevision < s.current.PolicyRevision ||
		(command.PolicyRevision == s.current.PolicyRevision && command.GeneratedAtUnixMs < s.current.GeneratedAtUnixMs) {
		return errors.New("stale relay grant bundle")
	}
	if proto.Equal(command, s.current) {
		return nil
	}
	data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(command)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.pending-%d", s.path, os.Getpid())
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	laneCountChanged := command.GetDataLanes() != s.current.GetDataLanes()
	s.current = proto.Clone(command).(*pb.SyncRelayGrantsCommand)
	if laneCountChanged {
		select {
		case s.changed <- struct{}{}:
		default:
		}
	}
	return nil
}

func (s *relayGrantStore) get() *pb.SyncRelayGrantsCommand {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return proto.Clone(s.current).(*pb.SyncRelayGrantsCommand)
}

func findRelayAssignment(bundle *pb.SyncRelayGrantsCommand, role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	for _, assignment := range bundle.Grants {
		if assignment.Role == role && assignment.OwnerKind == ownerKind && assignment.OwnerId == ownerID {
			return assignment
		}
	}
	return nil
}
