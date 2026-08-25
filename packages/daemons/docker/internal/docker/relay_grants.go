package docker

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const relayGrantFile = "relay-grants.json"

type relayGrantStore struct {
	path    string
	mu      sync.RWMutex
	current *pb.SyncRelayGrantsCommand
	changed chan struct{}
}

func newRelayGrantStore(stateDir string) (*relayGrantStore, error) {
	store := &relayGrantStore{path: filepath.Join(stateDir, relayGrantFile), current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1)}
	data, err := os.ReadFile(store.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return store, nil
		}
		return nil, err
	}
	command := &pb.SyncRelayGrantsCommand{}
	if err := protojson.Unmarshal(data, command); err != nil {
		return nil, fmt.Errorf("decode relay grants: %w", err)
	}
	store.current = command
	return store, nil
}

func (s *relayGrantStore) sync(command *pb.SyncRelayGrantsCommand) error {
	if command == nil {
		return errors.New("relay grant bundle is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if command.PolicyRevision < s.current.PolicyRevision {
		return fmt.Errorf("relay grant revision %d is older than %d", command.PolicyRevision, s.current.PolicyRevision)
	}
	if command.PolicyRevision == s.current.PolicyRevision && command.GeneratedAtUnixMs < s.current.GeneratedAtUnixMs {
		return fmt.Errorf("relay grant refresh %d is older than %d", command.GeneratedAtUnixMs, s.current.GeneratedAtUnixMs)
	}
	if command.PolicyRevision == s.current.PolicyRevision && proto.Equal(command, s.current) {
		return nil
	}
	data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(command)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.pending-%d", s.path, os.Getpid())
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Chmod(s.path, 0600); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	err = directory.Sync()
	if closeErr := directory.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
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

func (p *DockerPlugin) SyncRelayGrants(command *pb.SyncRelayGrantsCommand) (string, error) {
	if p.relayGrants == nil {
		return "", errors.New("relay grant store is unavailable")
	}
	if err := p.relayGrants.sync(command); err != nil {
		return "", err
	}
	p.reconcileRelayRegistrations()
	if p.cfg.Docker.Mode == "databases" {
		return "", nil
	}
	if p.registryProxy != nil {
		p.registryProxy.reconcileGrants()
	}
	detail, err := json.Marshal(map[string]string{"socketPath": databaseTunnelSocketPath(p.cfg.StateDir)})
	return string(detail), err
}
