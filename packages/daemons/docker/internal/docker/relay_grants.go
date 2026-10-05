package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/statecompat"
	"google.golang.org/protobuf/proto"
)

// relayGrantFile is what every daemon since v2.10.0 reads at start; it only
// holds the fields v2.10.0 knows. relayGrantFullFile holds the whole bundle
// (statecompat, B-10: a node rolled back to an older binary must start).
const (
	relayGrantFile     = "relay-grants.json"
	relayGrantFullFile = "relay-grants.full.json"
)

func relayGrantStateFile(stateDir string) statecompat.File {
	return statecompat.File{Legacy: filepath.Join(stateDir, relayGrantFile), Full: filepath.Join(stateDir, relayGrantFullFile)}
}

// relayGrantRestoreHold bounds how long a restarted daemon keeps its endpoint
// registrations back for the first grant bundle from Gateway. Policy may have
// changed while the daemon was down (a link deleted or re-issued), and the relay
// refuses a registration whose grant its current policy no longer lists. Gateway
// sends the bundle right after the node registers, well within this bound; when
// Gateway is unreachable the restored bundle is used once the hold runs out.
const relayGrantRestoreHold = 10 * time.Second

// relayGrantListenerReconcileTimeout bounds the database link listener reconcile of one grant sync.
const relayGrantListenerReconcileTimeout = 20 * time.Second

type relayGrantStore struct {
	file    statecompat.File
	mu      sync.RWMutex
	current *pb.SyncRelayGrantsCommand
	changed chan struct{}
	// restoredUntil is set while current came from disk and this process has not
	// accepted a bundle from Gateway yet.
	restoredUntil time.Time
}

func newRelayGrantStore(stateDir string) (*relayGrantStore, error) {
	store := &relayGrantStore{file: relayGrantStateFile(stateDir), current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1)}
	command := &pb.SyncRelayGrantsCommand{}
	found, err := store.file.Read(command)
	if err != nil {
		return nil, fmt.Errorf("decode relay grants: %w", err)
	}
	if !found {
		return store, nil
	}
	store.current = command
	// After a restart announced to the relays (B-13) they hold this daemon's registrations for the next process: it
	// takes them over at once, with the grants they were made with, instead of leaving them waiting for Gateway.
	if !consumeRestartMarker(stateDir, time.Now()) {
		store.restoredUntil = time.Now().Add(relayGrantRestoreHold)
	}
	return store, nil
}

// registrationHold is how long endpoint registrations should still wait for
// Gateway's first bundle; zero means they may register now.
func (s *relayGrantStore) registrationHold(now time.Time) time.Duration {
	if s == nil {
		return 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.restoredUntil.IsZero() {
		return 0
	}
	return max(s.restoredUntil.Sub(now), 0)
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
		s.restoredUntil = time.Time{}
		return nil
	}
	if err := s.file.Write(command); err != nil {
		return err
	}
	runtimeChanged := s.current.GetDataLanes() != command.GetDataLanes() ||
		!reflect.DeepEqual(relaybridge.RequiredTargets(s.current), relaybridge.RequiredTargets(command))
	s.current = proto.Clone(command).(*pb.SyncRelayGrantsCommand)
	s.restoredUntil = time.Time{}
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

// The accessors below run for every relayed connection: they read the current
// bundle in place (it is replaced, never modified) and copy at most one
// assignment, never the whole bundle (B-22).

// lookup returns a copy of one assignment of the current bundle.
func (s *relayGrantStore) lookup(role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	assignment := findRelayAssignment(s.current, role, ownerKind, ownerID)
	if assignment == nil {
		return nil
	}
	return proto.Clone(assignment).(*pb.RelayGrantAssignment)
}

// readChunkBytes is the bundle's relay read chunk size.
func (s *relayGrantStore) readChunkBytes() uint32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current.GetReadChunkBytes()
}

// withCurrent runs read on the current bundle, which read must not modify or
// keep.
func (s *relayGrantStore) withCurrent(read func(*pb.SyncRelayGrantsCommand)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	read(s.current)
}

func (p *DockerPlugin) SyncRelayGrants(command *pb.SyncRelayGrantsCommand) (string, error) {
	if p.relayGrants == nil {
		return "", errors.New("relay grant store is unavailable")
	}
	if err := p.relayGrants.sync(command); err != nil {
		return "", err
	}
	p.reconcileRelayRegistrations()
	// Resumable streams follow the bundle: off draining relays, ended when
	// their route or endpoint is gone.
	p.relayStreamsOnBundle()
	listenerStatuses := map[string]managedDatabaseHostListenerStatus{}
	if p.databaseListeners != nil {
		// Each network inspect has its own bound; this one bounds the whole set (a slow dockerd, many bindings).
		ctx, cancel := context.WithTimeout(context.Background(), relayGrantListenerReconcileTimeout)
		listenerStatuses = p.databaseListeners.reconcile(ctx, p.relayGrants.get())
		cancel()
	}
	if p.registryProxy != nil {
		p.registryProxy.reconcileGrants()
	}
	// The connector's egress listeners follow the connect assignments (D2); egress never enters the proxy
	// secure-link state.
	egressStatuses := map[string]egressStatus{}
	if p.secureLinks != nil {
		egressStatuses = p.secureLinks.syncEgress(p.relayGrants.get())
	}
	detail, err := json.Marshal(struct {
		StorageSocketPath string                                       `json:"storageSocketPath"`
		ListenerStatuses  map[string]managedDatabaseHostListenerStatus `json:"listenerStatuses"`
		EgressStatuses    map[string]egressStatus                      `json:"egressStatuses"`
	}{
		StorageSocketPath: storageConnectorRelaySocketPath(p.cfg.StateDir),
		ListenerStatuses:  listenerStatuses,
		EgressStatuses:    egressStatuses,
	})
	return string(detail), err
}

// reconcileAfterRestoreHold registers the restored bundle's endpoints once the
// hold runs out without a bundle from Gateway. A bundle that arrives first
// reconciles every router itself, and this later pass then only renews.
func (r *relayTunnelRouter) reconcileAfterRestoreHold(ctx context.Context) {
	hold := r.plugin.relayGrants.registrationHold(time.Now())
	if hold == 0 {
		return
	}
	r.plugin.logger.Info("relay endpoint registrations wait for the current grant bundle", "relay_instance_id", r.targetID, "max_wait", hold)
	go func() {
		timer := time.NewTimer(hold)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
			r.reconcileRegistrations()
		}
	}()
}

var _ lifecycle.RelayLatencyTargetPlugin = (*DockerPlugin)(nil)

// RelayLatencyTargets names every pool relay for the lifecycle's latency probes.
func (p *DockerPlugin) RelayLatencyTargets() []lifecycle.RelayTunnelTarget {
	targets := relaybridge.LatencyTargets(p.relayGrants.get())
	result := make([]lifecycle.RelayTunnelTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, lifecycle.RelayTunnelTarget{ID: target.ID, Addresses: relaybridge.TargetAddresses(target)})
	}
	return result
}
