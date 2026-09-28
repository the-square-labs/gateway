package docker

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

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

	// watchdog bootstraps a missing lease watchdog (nodes installed before it).
	watchdog *watchdogBootstrap

	// identity returns the PKIX DER public key that signs lease frames,
	// for AvailabilityLeaseReport.identity_public_key.
	identity func() []byte

	mu      sync.Mutex
	serving map[string]bool
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
	keys, err := newIdentityKeys(p.cfg.TLS.ClientCert, p.cfg.TLS.ClientKey, filepath.Join(p.cfg.StateDir, "availability-lease", "previous-identity.json"))
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
		identity: keys.publicKeyDER, serving: map[string]bool{},
	}
	runtime, err := lease.New(lease.Options{
		NodeID: stored.NodeID, StateDir: p.cfg.StateDir, Signer: keys.InitialSigner(), Identity: keys,
		Engine: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot, composeProjects: p.availability.leaseComposeProjects},
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
	// Every user-workload start passes the lease start hook (A5, A12.1).
	p.client.beforeStart = integration.beforeStart
	ctx, cancel := context.WithCancel(context.Background())
	integration.cancel = cancel
	go runtime.Run(ctx)
	p.lease = integration
	integration.watchdog = newWatchdogBootstrap(p.logger, integration.watchdogReady, p.cfg.Docker.LeaseWatchdogReleasesURL, p.cfg.Docker.LeaseWatchdogArtifactBaseURL)
	integration.watchdog.onPresent = p.signalRegistrationChanged
	integration.watchdog.Unavailable()
	go integration.watchdog.Run(ctx)
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

// leaseCapabilities advertises availability_lease_v1 only with a live
// watchdog (A12.4), and the missing-watchdog marker when this daemon cannot
// install one, so the policy mode reason asks to re-run the node installer.
func (p *DockerPlugin) leaseCapabilities() []string {
	if p.lease == nil {
		return nil
	}
	if p.lease.watchdogReady() {
		return []string{availabilityLeaseCapability}
	}
	if unavailable, _ := p.lease.watchdog.Unavailable(); unavailable {
		return []string{watchdogMissingCapability}
	}
	return nil
}

// RegistrationChanged implements lifecycle.RegistrationRefreshPlugin.
func (p *DockerPlugin) RegistrationChanged() <-chan struct{} {
	return p.registrationChanged
}

func (p *DockerPlugin) signalRegistrationChanged() {
	select {
	case p.registrationChanged <- struct{}{}:
	default:
	}
}

func (l *leaseIntegration) watchdogReady() bool {
	return lease.HeartbeatAlive(l.fence, leasefence.Now())
}

// SetServing implements lease.Endpoints: it flips the policy's endpoint gate,
// reconciles relay registrations and, when closing, waits until every
// registration stream of the policy has ended (A6).
func (l *leaseIntegration) SetServing(policyID string, serving bool) {
	l.mu.Lock()
	l.serving[policyID] = serving
	l.mu.Unlock()
	if serving {
		l.plugin.startLeaseDeploymentRouters(policyID)
	}
	if serving && l.plugin.secureLinks != nil {
		// A dormant target binding could not be prepared while its standby
		// was stopped; bind it now that the container runs.
		if err := l.plugin.secureLinks.restoreBindingsCoalesced(true); err != nil {
			l.plugin.logger.Warn("secure-link restore before serving failed", "policy_id", policyID, "error", err)
		}
	}
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

// startLeaseDeploymentRouters starts the stopped routers of this node's
// deployment placements of a policy before its holder serves. A router is not
// lease-governed: it only forwards to the active slot, which the holder alone
// runs. After a host reboot nothing else starts it, while the placement's
// Secure Link member targets it (stand run c2).
func (p *DockerPlugin) startLeaseDeploymentRouters(policyID string) {
	if p.client == nil || p.client.cli == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		p.logger.Warn("could not list the deployment routers of a lease holder", "policy_id", policyID, "error", err)
		return
	}
	for _, id := range leaseDeploymentRoutersToStart(policyID, containers) {
		if err := p.client.StartContainer(ctx, id); err != nil {
			p.logger.Warn("could not start the deployment router of a lease holder", "policy_id", policyID, "container_id", id, "error", err)
			continue
		}
		p.logger.Info("started the deployment router of a lease holder", "policy_id", policyID, "container_id", id)
	}
}

// leaseDeploymentRoutersToStart lists the stopped routers owned by the
// deployments whose app containers belong to the policy on this node.
func leaseDeploymentRoutersToStart(policyID string, containers []ContainerInfo) []string {
	deployments := map[string]bool{}
	for _, c := range containers {
		if c.Labels[availabilityPolicyLabel] == policyID && c.Labels[deploymentRoleLabel] == "app" {
			if id := c.Labels[deploymentIDLabel]; deploymentContainerLabelsOwned(c.Labels, id) {
				deployments[id] = true
			}
		}
	}
	var out []string
	for _, c := range containers {
		id := c.Labels[deploymentIDLabel]
		if c.State == "running" || c.Labels[deploymentRoleLabel] != "router" || !deployments[id] || !deploymentContainerLabelsOwned(c.Labels, id) {
			continue
		}
		out = append(out, c.ID)
	}
	return out
}

// endpointAllowed is the registration gate (D8, A8): the Secure Link
// endpoint of an availability member (T3's binding availability_policy_id,
// set for serving and dormant members alike, deployment routers included)
// registers only while this node serves the policy's lease. Links of
// policies outside lease mode keep today's behavior.
func (l *leaseIntegration) endpointAllowed(linkID string) bool {
	if l == nil || l.runtime == nil {
		return true
	}
	policyID := l.linkPolicy(linkID)
	if policyID == "" || !l.runtime.LeaseMode(policyID) {
		return true
	}
	// The named bootstrap holder keeps its legacy registration until its
	// first commit; relays admit it the same way (A5, T2).
	if l.runtime.BootstrapPending(policyID) {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.serving[policyID]
}

func (l *leaseIntegration) linkPolicy(linkID string) string {
	if l.plugin.secureLinkState == nil {
		return ""
	}
	for _, binding := range l.plugin.secureLinkState.Get().GetBindings() {
		if binding.GetLinkId() == linkID && binding.GetRole() == "target" {
			return binding.GetAvailabilityPolicyId()
		}
	}
	return ""
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
		out = append(out, c)
	}
	if activeSlot == "" {
		activeSlot = lastStartedDeploymentSlot(out)
	}
	if activeSlot == "" {
		return out
	}
	serve := out[:0:0]
	for _, c := range out {
		if c.Labels[deploymentRoleLabel] == "app" && c.Labels[deploymentSlotLabel] != activeSlot {
			continue
		}
		serve = append(serve, c)
	}
	return serve
}

// lastStartedDeploymentSlot picks the active blue/green slot when the placement
// record does not name it (a placement recorded by the legacy path): the slot
// whose app container Docker started last, since a switch starts the new slot
// before it stops the old one. Without it both slots would start after a host
// reboot (stand run c2). Blue, the deployment default, when neither ever ran.
func lastStartedDeploymentSlot(containers []lease.Container) string {
	slot, latest, slots := "", time.Time{}, map[string]bool{}
	for _, c := range containers {
		if c.Labels[deploymentRoleLabel] != "app" || c.Labels[deploymentSlotLabel] == "" {
			continue
		}
		slots[c.Labels[deploymentSlotLabel]] = true
		if slot == "" || c.StartedAt.After(latest) {
			slot, latest = c.Labels[deploymentSlotLabel], c.StartedAt
		}
	}
	if len(slots) < 2 {
		return ""
	}
	if latest.IsZero() {
		return "blue"
	}
	return slot
}

// MarkServing implements lease.Placements (T6 §3.1).
func (l *leaseIntegration) MarkServing(policyID string, serving bool) {
	if err := l.plugin.availability.markLeaseLifecycle(policyID, serving); err != nil {
		l.plugin.logger.Warn("could not record the availability placement lifecycle", "policy_id", policyID, "serving", serving, "error", err)
	}
}
