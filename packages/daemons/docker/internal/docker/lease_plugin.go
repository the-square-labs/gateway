package docker

import (
	"context"
	"crypto"
	"crypto/tls"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"google.golang.org/grpc"
)

const (
	availabilityLeaseCapability = "availability_lease_v1"
	// leaseWatchdogStartupWait lets a watchdog that boots after the daemon
	// prove itself before the registration capabilities are computed.
	leaseWatchdogStartupWait = 5 * time.Second
	endpointCloseWait        = 5 * time.Second
)

// leaseIntegration wires the availability lease runtime into the plugin: the
// relay endpoint gate (D8), the local placement view (D12) and the serving
// flags the runtime flips.
type leaseIntegration struct {
	plugin  *DockerPlugin
	runtime *lease.Runtime
	fence   lease.DirFence
	cancel  context.CancelFunc

	mu           sync.Mutex
	serving      map[string]bool
	linkPolicies map[string]string
}

// initAvailabilityLease starts the lease runtime on a general Docker node.
// It runs for the life of the process, independent of the Gateway session:
// fencing and failover must keep working while the Gateway is down.
func (p *DockerPlugin) initAvailabilityLease() {
	stored, err := state.Load(p.cfg.StateDir)
	if err != nil || stored.NodeID == "" {
		p.logger.Info("availability lease disabled until the node is enrolled")
		return
	}
	signer, err := newIdentityKeySigner(p.cfg.TLS.ClientCert, p.cfg.TLS.ClientKey)
	if err != nil {
		p.logger.Warn("availability lease disabled: node identity key unavailable", "error", err)
		return
	}
	root := p.cfg.Docker.LeaseWatchdogDir
	if root == "" {
		root = leasefence.DefaultRoot
	}
	integration := &leaseIntegration{
		plugin: p, fence: lease.DirFence{Dir: leasefence.Dir{Root: root}},
		serving: map[string]bool{}, linkPolicies: map[string]string{},
	}
	runtime, err := lease.New(lease.Options{
		NodeID: stored.NodeID, StateDir: p.cfg.StateDir, Signer: signer,
		Engine: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot},
		Fence:  integration.fence, Endpoints: integration, Placements: integration, Logger: p.logger,
	})
	if err != nil {
		p.logger.Warn("availability lease disabled", "error", err)
		return
	}
	integration.runtime = runtime
	if _, statErr := os.Stat(integration.fence.Dir.HeartbeatPath()); statErr == nil {
		for deadline := time.Now().Add(leaseWatchdogStartupWait); time.Now().Before(deadline) && !integration.watchdogReady(); {
			time.Sleep(250 * time.Millisecond)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	integration.cancel = cancel
	go runtime.Run(ctx)
	p.lease = integration
	p.logger.Info("availability lease runtime started", "node_id", stored.NodeID, "watchdog_ready", integration.watchdogReady())
}

// attachRelay opens the Coordinate stream on a relay transport for as long
// as the transport lives: one stream per relay the daemon holds (D3).
func (l *leaseIntegration) attachRelay(ctx context.Context, conn grpc.ClientConnInterface, relayInstanceID string) {
	if l == nil || l.runtime == nil {
		return
	}
	go l.runtime.Transport().Run(ctx, relayInstanceID, func(streamCtx context.Context) (lease.FrameStream, error) {
		return lease.OpenCoordinateStream(streamCtx, conn)
	})
}

func (l *leaseIntegration) watchdogReady() bool {
	return l.fence.HeartbeatFresh(leasefence.Now())
}

// SetServing implements lease.Endpoints: it flips the policy's endpoint gate,
// reconciles relay registrations and, when closing, waits until every
// registration stream of the policy has ended (A6).
func (l *leaseIntegration) SetServing(policyID string, serving bool) {
	l.mu.Lock()
	l.serving[policyID] = serving
	l.mu.Unlock()
	l.refreshLinkPolicies()
	closed := l.plugin.reconcileRelayRegistrations()
	if serving {
		return
	}
	timeout := time.NewTimer(endpointCloseWait)
	defer timeout.Stop()
	for _, done := range closed {
		select {
		case <-done:
		case <-timeout.C:
			l.plugin.logger.Warn("relay endpoint registration did not close in time", "policy_id", policyID)
			return
		}
	}
}

// endpointAllowed is the registration gate (D8, A8): a Secure Link endpoint
// of a lease-mode policy registers only while this node serves it.
func (l *leaseIntegration) endpointAllowed(linkID string) bool {
	if l == nil || l.runtime == nil {
		return true
	}
	l.mu.Lock()
	policyID := l.linkPolicies[linkID]
	serving := l.serving[policyID]
	l.mu.Unlock()
	if policyID == "" || !l.runtime.LeaseMode(policyID) {
		return true
	}
	return serving
}

// refreshLinkPolicies maps Secure Link ids to availability policies through
// the target container labels. Integration point: once T3's
// ProxySecureLinkBinding.availability_policy_id lands, use it directly.
func (l *leaseIntegration) refreshLinkPolicies() {
	p := l.plugin
	if p.secureLinkState == nil || p.client == nil {
		return
	}
	bindings := p.secureLinkState.Get().GetBindings()
	if len(bindings) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		return
	}
	labels := map[string]map[string]string{}
	for _, c := range containers {
		labels[c.Name] = c.Labels
		labels[c.ID] = c.Labels
	}
	next := map[string]string{}
	for _, binding := range bindings {
		if binding.GetRole() == "target" {
			next[binding.GetLinkId()] = labels[binding.GetTargetContainer()][availabilityPolicyLabel]
		}
	}
	l.mu.Lock()
	l.linkPolicies = next
	l.mu.Unlock()
}

// Local implements lease.Placements from the persisted availability state.
func (l *leaseIntegration) Local(policyID string) (lease.Placement, bool) {
	placement, ok := l.plugin.availability.leasePlacement(policyID)
	if !ok {
		return lease.Placement{}, false
	}
	return lease.Placement{PlacementID: placement.PlacementID, Generation: placement.HighestGeneration}, true
}

// ServeSet keeps the containers of this node's current placement and, for
// deployments, only the active slot's app container (the router is not
// lease-governed: without the app it serves nothing).
func (l *leaseIntegration) ServeSet(policyID string, containers []lease.Container) []lease.Container {
	placement, known := l.plugin.availability.leasePlacement(policyID)
	activeSlot := ""
	if known {
		if slot, ok := availabilityRuntimeIdentity(placement.RuntimeMetadata)["activeSlot"].(string); ok {
			activeSlot = slot
		}
	}
	var out []lease.Container
	for _, c := range containers {
		if known && c.PlacementID != "" && c.PlacementID != placement.PlacementID {
			continue
		}
		if activeSlot != "" && c.Labels[deploymentRoleLabel] == "app" && c.Labels[deploymentSlotLabel] != activeSlot {
			continue
		}
		out = append(out, c)
	}
	return out
}

// identityKeySigner signs lease frames with the node's mTLS identity key
// (ECDSA P-256, D3), reloading it after certificate renewal.
type identityKeySigner struct {
	certPath, keyPath string
	mu                sync.Mutex
	modTime           time.Time
	key               crypto.Signer
}

func newIdentityKeySigner(certPath, keyPath string) (*identityKeySigner, error) {
	signer := &identityKeySigner{certPath: certPath, keyPath: keyPath}
	if _, err := signer.current(); err != nil {
		return nil, err
	}
	return signer, nil
}

func (s *identityKeySigner) current() (crypto.Signer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.keyPath)
	if err != nil {
		if s.key != nil {
			return s.key, nil
		}
		return nil, err
	}
	if s.key != nil && info.ModTime().Equal(s.modTime) {
		return s.key, nil
	}
	pair, err := tls.LoadX509KeyPair(s.certPath, s.keyPath)
	if err != nil {
		if s.key != nil {
			return s.key, nil
		}
		return nil, err
	}
	key, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("node identity key cannot sign")
	}
	s.key, s.modTime = key, info.ModTime()
	return key, nil
}

func (s *identityKeySigner) Sign(message []byte) ([]byte, error) {
	key, err := s.current()
	if err != nil {
		return nil, fmt.Errorf("load node identity key: %w", err)
	}
	return availabilitylease.ECDSASigner{Key: key}.Sign(message)
}
