package daemon

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/statecompat"
	"google.golang.org/protobuf/proto"
)

type relayGrantStore struct {
	file    statecompat.File
	mu      sync.RWMutex
	current *pb.SyncRelayGrantsCommand
	changed chan struct{}
}

// relay-grants.json is what every daemon since v2.10.0 reads at start and
// only holds the fields v2.10.0 knows; relay-grants.full.json holds the whole
// bundle (statecompat, B-10: a node rolled back to an older binary must
// start).
func newRelayGrantStore(stateDir string) (*relayGrantStore, error) {
	store := &relayGrantStore{
		file:    statecompat.File{Legacy: filepath.Join(stateDir, "relay-grants.json"), Full: filepath.Join(stateDir, "relay-grants.full.json")},
		current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1),
	}
	command := &pb.SyncRelayGrantsCommand{}
	found, err := store.file.Read(command)
	if err != nil {
		return nil, fmt.Errorf("decode relay grants: %w", err)
	}
	if found {
		store.current = command
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
	if err := s.file.Write(command); err != nil {
		return err
	}
	runtimeChanged := s.current.GetDataLanes() != command.GetDataLanes() ||
		!reflect.DeepEqual(relaybridge.RequiredTargets(s.current), relaybridge.RequiredTargets(command))
	s.current = proto.Clone(command).(*pb.SyncRelayGrantsCommand)
	if runtimeChanged {
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

var _ lifecycle.RelayLatencyTargetPlugin = (*NginxPlugin)(nil)

// RelayLatencyTargets names every pool relay for the lifecycle's latency probes.
func (p *NginxPlugin) RelayLatencyTargets() []lifecycle.RelayTunnelTarget {
	targets := relaybridge.LatencyTargets(p.relayGrants.get())
	result := make([]lifecycle.RelayTunnelTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, lifecycle.RelayTunnelTarget{ID: target.ID, Addresses: relaybridge.TargetAddresses(target)})
	}
	return result
}
