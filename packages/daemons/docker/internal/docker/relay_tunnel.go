package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/protobuf/proto"
)

const databaseTunnelIdleTimeout = 5 * time.Minute

var _ lifecycle.RelayPoolTunnelPlugin = (*DockerPlugin)(nil)

type relayTunnelRouter struct {
	plugin        *DockerPlugin
	ctx           context.Context
	client        relayv1.TunnelBrokerClient
	targetID      string
	mu            sync.Mutex
	registrations map[string]*relayEndpointRegistration
	accepted      map[*acceptedRelayTunnel]struct{}
	listener      net.Listener
	active        atomic.Int64
	// transportReady closes (and is replaced) whenever the relay transport
	// connects again, so registrations waiting out their backoff retry at once.
	transportReady chan struct{}
}

type relayEndpointRegistration struct {
	cancel context.CancelFunc
	renew  chan relayRegistrationUpdate
	ready  atomic.Bool
	// done closes when the registration stream and its tunnels have ended.
	done chan struct{}
	// The assignment and serving state last handed to the registration. An identical pair is not
	// renewed again: Gateway resends unchanged bundles, and each renewal is a relay round trip.
	latest *pb.RelayGrantAssignment
	state  relayv1.EndpointServingState
}

// relayRegistrationUpdate is what one registration sends the relay: its grant and whether the
// endpoint takes traffic (D6, D7).
type relayRegistrationUpdate struct {
	assignment *pb.RelayGrantAssignment
	state      relayv1.EndpointServingState
}

// BackupRelayRoute is a daemon-local TCP entrypoint for one signed, per-run
// relay connect grant. It accepts concurrent helper connections until Close;
// it neither opens a host port nor accepts an upstream endpoint supplied by
// Gateway.
type BackupRelayRoute struct {
	Address  string
	listener net.Listener
	cancel   context.CancelFunc
	done     chan struct{}
	once     sync.Once
	active   sync.WaitGroup
}

func (r *BackupRelayRoute) Close() {
	if r == nil {
		return
	}
	r.once.Do(func() {
		r.cancel()
		_ = r.listener.Close()
		<-r.done
	})
}

func (p *DockerPlugin) RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, _ string) {
	p.RunRelayTargetTunnels(ctx, conn, "", relaybridge.LegacyTargetID)
}

func (p *DockerPlugin) RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, _ string, relayInstanceID string) {
	router := &relayTunnelRouter{plugin: p, ctx: ctx, client: relayv1.NewTunnelBrokerClient(conn), targetID: relayInstanceID, registrations: map[string]*relayEndpointRegistration{}, transportReady: make(chan struct{})}
	go router.watchTransport(ctx, conn)
	p.relayTunnelMu.Lock()
	if p.relayTunnels == nil {
		p.relayTunnels = map[string]*relayTunnelRouter{}
	}
	if p.relayTunnels[relayInstanceID] != nil {
		p.relayTunnelMu.Unlock()
		<-ctx.Done()
		return
	}
	p.relayTunnels[relayInstanceID] = router
	p.relayTunnelMu.Unlock()
	defer func() {
		router.stop()
		p.relayTunnelMu.Lock()
		if p.relayTunnels[relayInstanceID] == router {
			delete(p.relayTunnels, relayInstanceID)
		}
		p.relayTunnelMu.Unlock()
	}()
	if p.cfg.Docker.Mode != "databases" && p.cfg.Docker.Mode != "storage" {
		if err := p.startRelayListener(); err != nil {
			p.logger.Warn("relay tunnel listener failed", "error", err)
			return
		}
	}
	router.reconcileRegistrations()
	router.reconcileAfterRestoreHold(ctx)
	p.lease.attachRelay(ctx, conn, relayInstanceID)
	<-ctx.Done()
}

func (p *DockerPlugin) RelayTunnelTargets() []lifecycle.RelayTunnelTarget {
	targets := relaybridge.RequiredTargets(p.relayGrants.get())
	result := make([]lifecycle.RelayTunnelTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, lifecycle.RelayTunnelTarget{
			ID: target.ID, Addresses: relaybridge.TargetAddresses(target), CertificateIdentity: target.CertificateIdentity,
			CertificateFingerprint: target.CertificateFingerprint,
		})
	}
	return result
}

func (p *DockerPlugin) RelayTunnelLaneCount() int {
	lanes := int(p.relayGrants.get().GetDataLanes())
	if lanes < 1 {
		return 4
	}
	return lanes
}

func (p *DockerPlugin) RelayTunnelRuntimeChanged() <-chan struct{} {
	return p.relayGrants.changed
}

// reconcileRegistrations returns the done channels of the registrations it
// cancelled, so a lease release can wait until they are gone (A6).
func (r *relayTunnelRouter) reconcileRegistrations() []chan struct{} {
	bundle := r.plugin.relayGrants.get()
	r.enforceRevocationFences(bundle)
	if r.plugin.relayGrants.registrationHold(time.Now()) > 0 {
		// Grants restored from disk may predate the relay's policy and no
		// registration exists yet: wait for Gateway's bundle (relayGrantRestoreHold).
		return nil
	}
	desired := map[string]relayRegistrationUpdate{}
	if r.plugin.cfg.Docker.IsStorageProfile() {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && (isManagedStorageRelayOwnerKind(assignment.OwnerKind) || isManagedDatabaseRelayOwnerKind(assignment.OwnerKind)) && assignment.EndpointId != "" {
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = relayRegistrationUpdate{assignment: projected}
				}
			}
		}
	} else {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && assignment.OwnerKind == proxySecureLinkOwnerKind && assignment.EndpointId != "" {
				// Availability members register on every assigned relay, dormant
				// until they serve and their workload is ready (D6, D7).
				state := r.plugin.memberEndpointState(assignment.OwnerId)
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = relayRegistrationUpdate{assignment: projected, state: state}
				}
			}
		}
	}
	var cancelled []chan struct{}
	r.mu.Lock()
	removed, renewed := 0, 0
	for id, registration := range r.registrations {
		update, ok := desired[id]
		if !ok {
			registration.cancel()
			cancelled = append(cancelled, registration.done)
			delete(r.registrations, id)
			removed++
			continue
		}
		if !proto.Equal(registration.latest, update.assignment) || registration.state != update.state {
			registration.latest, registration.state = update.assignment, update.state
			queueLatestRelayGrant(registration.renew, update)
			renewed++
		}
		delete(desired, id)
	}
	for id, update := range desired {
		ctx, cancel := context.WithCancel(r.ctx)
		registration := &relayEndpointRegistration{cancel: cancel, renew: make(chan relayRegistrationUpdate, 1), done: make(chan struct{}), latest: update.assignment, state: update.state}
		r.registrations[id] = registration
		go func() {
			defer close(registration.done)
			r.runRegistration(ctx, update, registration.renew)
		}()
	}
	log := r.plugin.logger.Debug
	if removed > 0 || len(desired) > 0 {
		log = r.plugin.logger.Info
	}
	log("relay endpoint registrations reconciled", "relay_instance_id", r.targetID, "registrations", len(r.registrations),
		"added", len(desired), "removed", removed, "renewed", renewed)
	r.mu.Unlock()
	return cancelled
}

func (p *DockerPlugin) reconcileRelayRegistrations() []chan struct{} {
	p.relayTunnelMu.Lock()
	routers := make([]*relayTunnelRouter, 0, len(p.relayTunnels))
	for _, router := range p.relayTunnels {
		if router != nil {
			routers = append(routers, router)
		}
	}
	p.relayTunnelMu.Unlock()
	var cancelled []chan struct{}
	for _, router := range routers {
		cancelled = append(cancelled, router.reconcileRegistrations()...)
	}
	return cancelled
}

func assignmentsForRelayTarget(assignment *pb.RelayGrantAssignment, targetID string) []*pb.RelayGrantAssignment {
	candidates := relaybridge.PreparedCandidates(assignment)
	if len(candidates) == 0 {
		if targetID != relaybridge.LegacyTargetID {
			return nil
		}
		return []*pb.RelayGrantAssignment{proto.Clone(assignment).(*pb.RelayGrantAssignment)}
	}
	result := make([]*pb.RelayGrantAssignment, 0, len(candidates))
	for _, candidate := range candidates {
		matchesLegacyLocal := targetID == relaybridge.LegacyTargetID && len(candidate.GetAddresses()) == 0
		if candidate.GetRelayInstanceId() != targetID && !matchesLegacyLocal {
			continue
		}
		projected := proto.Clone(assignment).(*pb.RelayGrantAssignment)
		projected.Grant = proto.Clone(candidate.GetGrant()).(*pb.RelaySignedGrant)
		projected.Candidates = []*pb.RelayDataCandidate{proto.Clone(candidate).(*pb.RelayDataCandidate)}
		result = append(result, projected)
	}
	return result
}

func relayRegistrationKey(assignment *pb.RelayGrantAssignment) string {
	generation := uint64(0)
	if len(assignment.GetCandidates()) == 1 {
		generation = assignment.GetCandidates()[0].GetAssignmentGeneration()
	}
	return fmt.Sprintf("%s:%d", assignment.GetEndpointId(), generation)
}

func queueLatestRelayGrant(target chan relayRegistrationUpdate, update relayRegistrationUpdate) {
	select {
	case target <- update:
		return
	default:
	}
	select {
	case <-target:
	default:
	}
	select {
	case target <- update:
	default:
	}
}

// watchTransport wakes registrations that wait out a retry backoff whenever the
// relay transport becomes ready again: a relay coming back is registered with
// at once, while a relay that stays down or keeps refusing is retried slowly.
func (r *relayTunnelRouter) watchTransport(ctx context.Context, conn *grpc.ClientConn) {
	if conn == nil {
		return
	}
	state := conn.GetState()
	for conn.WaitForStateChange(ctx, state) {
		state = conn.GetState()
		if state != connectivity.Ready {
			continue
		}
		r.mu.Lock()
		close(r.transportReady)
		r.transportReady = make(chan struct{})
		r.mu.Unlock()
	}
}

func (r *relayTunnelRouter) transportReadySignal() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.transportReady == nil {
		r.transportReady = make(chan struct{})
	}
	return r.transportReady
}

// Endpoint registration retries back off exponentially with jitter (N-7): a
// refusing or unreachable relay is otherwise asked once a second per endpoint.
// Lease lanes (lease.Transport) keep their own short retry.
const (
	relayRegistrationRetryInitial = time.Second
	relayRegistrationRetryMax     = 15 * time.Second
)

// relayRegistrationRetryDelay is the wait before retry number attempt (from 1):
// doubling from one second up to the cap, each drawn uniformly from the upper
// half of the step so endpoints and daemons do not retry in lockstep.
func relayRegistrationRetryDelay(attempt int, random func() float64) time.Duration {
	step := relayRegistrationRetryInitial
	for i := 1; i < attempt && step < relayRegistrationRetryMax; i++ {
		step *= 2
	}
	step = min(step, relayRegistrationRetryMax)
	return step/2 + time.Duration(random()*float64(step/2))
}

func (r *relayTunnelRouter) runRegistration(ctx context.Context, update relayRegistrationUpdate, renew <-chan relayRegistrationUpdate) {
	current, state := update.assignment, update.state
	failures := 0
	for ctx.Err() == nil {
		registered := false
		attemptCtx, cancelAttempt := context.WithCancel(ctx)
		stream, err := r.client.RegisterEndpoint(attemptCtx)
		if err == nil {
			err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{Grant: relayGrant(current.Grant), State: state}}})
		}
		if err == nil {
			received := make(chan *relayv1.EndpointControl)
			receiveErr := make(chan error, 1)
			go func() {
				for {
					message, recvErr := stream.Recv()
					if recvErr != nil {
						receiveErr <- recvErr
						return
					}
					select {
					case received <- message:
					case <-attemptCtx.Done():
						return
					}
				}
			}()
			for err == nil {
				select {
				case <-ctx.Done():
					err = ctx.Err()
				case next := <-renew:
					current, state = next.assignment, next.state
					err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{Grant: relayGrant(current.Grant), State: state}}})
				case message := <-received:
					if message.GetRegistered() != nil {
						// The relay confirms every renewal the same way; only the first is news.
						log := r.plugin.logger.Debug
						if !registered {
							log = r.plugin.logger.Info
						}
						registered, failures = true, 0
						log("relay endpoint registered", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId, "state", state.String())
						r.mu.Lock()
						if registration := r.registrations[relayRegistrationKey(current)]; registration != nil {
							registration.ready.Store(true)
						}
						r.mu.Unlock()
						continue
					}
					if incoming := message.GetIncoming(); incoming != nil {
						// Bind accepted streams to the endpoint registration, not the
						// process. Revoking the assignment therefore cancels existing
						// streams without disturbing unrelated node links.
						go r.acceptIncoming(ctx, current, incoming)
					}
				case err = <-receiveErr:
				}
			}
		}
		cancelAttempt()
		if ctx.Err() != nil {
			return
		}
		failures++
		delay := relayRegistrationRetryDelay(failures, rand.Float64)
		log := r.plugin.logger.Warn
		if failures > 1 {
			// The first failure is news; the retries of a relay that stays
			// down or keeps refusing are not (838 lines in 2 min, stand run c).
			log = r.plugin.logger.Debug
		}
		log("relay endpoint registration disconnected", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId, "error", err, "retry_in", delay.Round(time.Millisecond).String(), "failures", failures)
		wake := r.transportReadySignal()
		retry := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			retry.Stop()
			return
		case next := <-renew:
			retry.Stop()
			current, state = next.assignment, next.state
		case <-wake:
			retry.Stop()
		case <-retry.C:
		}
	}
}

func (r *relayTunnelRouter) acceptIncoming(ctx context.Context, assignment *pb.RelayGrantAssignment, incoming *relayv1.IncomingTunnel) {
	tunnelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Refused tunnels are never accepted: the relay times the opener out.
	release, refusal := r.admitIncoming(assignment, incoming, cancel)
	if refusal != "" {
		return
	}
	defer release()
	stream, err := r.client.AcceptTunnel(tunnelCtx)
	if err != nil {
		r.plugin.logger.Warn("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId, "stage", "accept", "error", err)
		return
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: incoming.AcceptToken}}}); err != nil {
		r.plugin.logger.Warn("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId, "stage", "authorize", "error", err)
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		r.plugin.logger.Warn("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId, "stage", "ready", "error", err)
		return
	}
	var connection net.Conn
	switch assignment.OwnerKind {
	case "managed_database":
		if r.plugin.databaseManager == nil {
			return
		}
		// Links and the Gateway's database tools: TLS-enabled PostgreSQL gets
		// TLS from this daemon unless the client negotiates it itself.
		connection, err = r.plugin.databaseManager.dialLink(ctx, assignment.OwnerId, stream, cancel)
	case "database_backup_source", "database_backup_restore":
		if r.plugin.databaseManager == nil || !managedDatabaseIDPattern.MatchString(assignment.GetRouteId()) {
			return
		}
		// ownerId is the signed backup-run UUID. routeId is the server-selected
		// managed database UUID, never a client-provided address or port.
		connection, err = r.plugin.databaseManager.dial(ctx, assignment.GetRouteId())
	case proxySecureLinkOwnerKind:
		if r.plugin.secureLinks == nil {
			return
		}
		if r.plugin.memberEndpointState(assignment.OwnerId) == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
			// A dormant member (standby, released or fenced holder, or a holder
			// whose workload is not ready) takes no traffic even if a relay
			// admitted a tunnel before it heard so (D6, D7). The error reaches
			// the opener at once instead of an accept timeout.
			err = errMemberEndpointDormant
			break
		}
		connection, err = r.plugin.secureLinks.dial(ctx, assignment.OwnerId)
	case "managed_storage", "managed_storage_binding", "managed_storage_gateway":
		if r.plugin.storageManager == nil {
			return
		}
		connection, err = r.plugin.storageManager.dial(ctx, assignment.OwnerId)
	case "storage_backup_target", "storage_backup_staging":
		if r.plugin.storageManager == nil || !managedStorageIDPattern.MatchString(assignment.GetRouteId()) {
			return
		}
		// ownerId is the signed backup-run UUID. routeId is the server-selected
		// managed storage UUID, never an address supplied by the backup runner.
		connection, err = r.plugin.storageManager.dial(ctx, assignment.GetRouteId())
	default:
		return
	}
	if err != nil {
		r.plugin.logger.Warn("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId, "stage", "dial", "error", err)
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "endpoint_unavailable", Message: "Endpoint is unavailable"}}})
		return
	}
	defer connection.Close()
	if assignment.OwnerKind == proxySecureLinkOwnerKind {
		readChunk := int(r.plugin.relayGrants.get().GetReadChunkBytes())
		if readChunk == 0 {
			readChunk = relaybridge.DefaultChunkBytes
		}
		_ = relaybridge.BridgeWithChunk(tunnelCtx, connection, stream, int(first.GetReady().MaxFrameBytes), readChunk, cancel)
		return
	}
	_ = bridgeRelayConnection(connection, stream, int(first.GetReady().MaxFrameBytes), cancel)
}

func isManagedStorageRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "managed_storage" || ownerKind == "managed_storage_binding" || ownerKind == "managed_storage_gateway" || ownerKind == "storage_backup_target" || ownerKind == "storage_backup_staging"
}

func isManagedDatabaseRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "managed_database" || ownerKind == "database_backup_source" || ownerKind == "database_backup_restore"
}

func isBackupRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "database_backup_source" || ownerKind == "database_backup_restore" ||
		ownerKind == "storage_backup_target" || ownerKind == "storage_backup_staging"
}

func (p *DockerPlugin) startRelayListener() error {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	if p.relayListener != nil {
		return nil
	}
	if err := prepareDatabaseTunnelSocketDirectory(p.cfg.StateDir); err != nil {
		return err
	}
	path := databaseTunnelSocketPath(p.cfg.StateDir)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	if err := os.Chmod(path, 0666); err != nil {
		listener.Close()
		return err
	}
	p.relayListener = listener
	go p.acceptRelayLoop(listener)
	return nil
}

func (p *DockerPlugin) acceptRelayLoop(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go p.openSidecar(connection)
	}
}

func (p *DockerPlugin) openSidecar(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	bindingID, err := readDatabaseTunnelHandshake(connection)
	_ = connection.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	p.openManagedDatabaseBinding(connection, bindingID, 0)
}

func (p *DockerPlugin) openManagedDatabaseBinding(connection net.Conn, bindingID string, routeGeneration uint64) {
	assignment := findRelayAssignment(p.relayGrants.get(), "connect", "managed_database_binding", bindingID)
	if assignment == nil {
		return
	}
	if routeGeneration != 0 {
		listener := assignment.GetManagedDatabaseListener()
		if listener == nil || listener.GetRouteGeneration() != routeGeneration {
			return
		}
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	candidates = p.orderRelayCandidates(candidates)
	for _, candidate := range candidates {
		router := p.relayRouter(candidate.GetRelayInstanceId())
		if router != nil && router.openSourceTunnel(connection, candidate.GetGrant()) {
			return
		}
	}
}

func (p *DockerPlugin) orderRelayCandidates(candidates []*pb.RelayDataCandidate) []*pb.RelayDataCandidate {
	if len(candidates) < 2 {
		return append([]*pb.RelayDataCandidate(nil), candidates...)
	}
	p.relayTunnelMu.Lock()
	transports := make(map[string]relaybridge.TransportLoad, len(p.relayTunnels))
	for targetID, router := range p.relayTunnels {
		transports[targetID] = relaybridge.TransportLoad{Available: true, Active: router.active.Load()}
	}
	rotation := p.relaySelection
	p.relaySelection++
	p.relayTunnelMu.Unlock()
	return relaybridge.OrderCandidates(candidates, transports, rotation, relaybridge.Latency.RTT)
}

func (p *DockerPlugin) relayRouter(targetID string) *relayTunnelRouter {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	return p.relayTunnels[targetID]
}

// OpenBackupRelayRoute resolves a signed per-run connect grant. routeID is the
// RelayGrantAssignment.ownerId (the backup run UUID); the matching endpoint
// assignment's routeId selects the owned target runtime server-side.
func (p *DockerPlugin) OpenBackupRelayRoute(ctx context.Context, ownerKind, routeID string) (*BackupRelayRoute, error) {
	if !isBackupRelayOwnerKind(ownerKind) {
		return nil, errors.New("unsupported backup relay route owner kind")
	}
	if !managedStorageIDPattern.MatchString(routeID) {
		return nil, errors.New("backup relay route id must be a UUID")
	}
	assignment := findRelayAssignment(p.relayGrants.get(), "connect", ownerKind, routeID)
	if assignment == nil || (assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0) {
		return nil, errors.New("backup relay route is unavailable")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("open backup relay loopback listener: %w", err)
	}
	routeCtx, cancel := context.WithCancel(ctx)
	route := &BackupRelayRoute{Address: listener.Addr().String(), listener: listener, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(route.done)
		defer listener.Close()
		defer route.active.Wait()
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			if routeCtx.Err() != nil {
				_ = connection.Close()
				return
			}
			route.active.Add(1)
			go func(connection net.Conn) {
				defer route.active.Done()
				defer connection.Close()
				closeOnCancel := make(chan struct{})
				go func() {
					select {
					case <-routeCtx.Done():
						_ = connection.Close()
					case <-closeOnCancel:
					}
				}()
				defer close(closeOnCancel)
				// A backup can outlive its grants (TTL, generation or key change):
				// use the newest bundle's assignment for each connection.
				current := findRelayAssignment(p.relayGrants.get(), "connect", ownerKind, routeID)
				if current == nil {
					current = assignment
				}
				candidates := relaybridge.PoolCandidates(current, false)
				if len(candidates) == 0 {
					candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: current.GetGrant()}}
				}
				for _, candidate := range p.orderRelayCandidates(candidates) {
					router := p.relayRouter(candidate.GetRelayInstanceId())
					if router != nil && router.openSourceTunnel(connection, candidate.GetGrant()) {
						return
					}
				}
			}(connection)
		}
	}()
	return route, nil
}

func (r *relayTunnelRouter) openSourceTunnel(connection net.Conn, grant *pb.RelaySignedGrant) bool {
	tunnelCtx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	stream, err := r.client.OpenTunnel(tunnelCtx)
	if err != nil {
		return false
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}}); err != nil {
		return false
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		return false
	}
	r.active.Add(1)
	defer r.active.Add(-1)
	_ = bridgeRelayConnection(connection, stream, int(first.GetReady().MaxFrameBytes), cancel)
	return true
}

func (p *DockerPlugin) ProbeRelayCandidate(command *pb.ProbeRelayCandidateCommand) (string, error) {
	if command == nil || command.GetCandidate() == nil ||
		command.GetAssignmentGeneration() != command.GetCandidate().GetAssignmentGeneration() {
		return "", errors.New("invalid relay candidate probe")
	}
	deadline := time.Now().Add(10 * time.Second)
	var lastErr error
	switch command.GetRole() {
	case "target":
		for time.Now().Before(deadline) {
			router := p.relayRouter(command.GetCandidate().GetRelayInstanceId())
			if router != nil {
				key := fmt.Sprintf("%s:%d", command.GetEndpointId(), command.GetAssignmentGeneration())
				router.mu.Lock()
				registration := router.registrations[key]
				ready := registration != nil && registration.ready.Load()
				router.mu.Unlock()
				if ready {
					lastErr = nil
					break
				}
			}
			lastErr = errors.New("relay endpoint registration is not ready")
			time.Sleep(100 * time.Millisecond)
		}
	case "source":
		for time.Now().Before(deadline) {
			router := p.relayRouter(command.GetCandidate().GetRelayInstanceId())
			if router == nil {
				lastErr = errors.New("relay candidate lane is unavailable")
				time.Sleep(100 * time.Millisecond)
				continue
			}
			ctx, cancel := context.WithTimeout(router.ctx, 2*time.Second)
			stream, err := router.client.OpenTunnel(ctx)
			if err == nil {
				err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(command.GetCandidate().GetGrant())}}})
			}
			if err == nil {
				var first *relayv1.TunnelFrame
				first, err = stream.Recv()
				if err == nil && first.GetReady() == nil {
					err = errors.New("relay candidate did not acknowledge tunnel")
				}
			}
			cancel()
			if err == nil {
				lastErr = nil
				break
			}
			lastErr = err
			time.Sleep(100 * time.Millisecond)
		}
	default:
		return "", errors.New("unsupported relay candidate probe role")
	}
	if lastErr != nil {
		return "", lastErr
	}
	detail, err := json.Marshal(map[string]any{"probeId": command.GetProbeId(), "ready": true})
	return string(detail), err
}

type relayFrameStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

type relayBridgeResult struct {
	local    bool
	terminal bool
	err      error
}

func bridgeRelayConnection(connection net.Conn, stream relayFrameStream, maxFrame int, cancel context.CancelFunc) error {
	if maxFrame <= 0 || maxFrame > databaseTunnelMaxChunkBytes {
		maxFrame = databaseTunnelMaxChunkBytes
	}
	result := make(chan relayBridgeResult, 2)
	go func() {
		buffer := make([]byte, maxFrame)
		for {
			n, err := connection.Read(buffer)
			if n > 0 {
				_ = connection.SetDeadline(time.Now().Add(databaseTunnelIdleTimeout))
				if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), buffer[:n]...)}}}); sendErr != nil {
					result <- relayBridgeResult{local: true, terminal: true, err: sendErr}
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}); sendErr != nil {
						result <- relayBridgeResult{local: true, terminal: true, err: sendErr}
						return
					}
					result <- relayBridgeResult{local: true}
					return
				}
				result <- relayBridgeResult{local: true, terminal: true, err: err}
				return
			}
		}
	}()
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				result <- relayBridgeResult{terminal: true, err: err}
				return
			}
			switch {
			case frame.GetData() != nil:
				data := frame.GetData().Data
				if len(data) == 0 || len(data) > maxFrame {
					result <- relayBridgeResult{terminal: true, err: fmt.Errorf("invalid relay frame size")}
					return
				}
				if err := writeDatabaseTunnelBytes(connection, data); err != nil {
					result <- relayBridgeResult{terminal: true, err: err}
					return
				}
				_ = connection.SetDeadline(time.Now().Add(databaseTunnelIdleTimeout))
			case frame.GetHalfClose() != nil:
				// *net.TCPConn, or *tls.Conn for a TLS-enabled PostgreSQL link.
				if half, ok := connection.(interface{ CloseWrite() error }); ok {
					_ = half.CloseWrite()
				}
				result <- relayBridgeResult{}
				return
			case frame.GetClose() != nil:
				result <- relayBridgeResult{terminal: true}
				return
			case frame.GetError() != nil:
				result <- relayBridgeResult{terminal: true, err: fmt.Errorf("relay tunnel error: %s", frame.GetError().Code)}
				return
			default:
				result <- relayBridgeResult{terminal: true, err: fmt.Errorf("unexpected relay tunnel frame")}
				return
			}
		}
	}()
	var localDone, remoteDone, terminated bool
	var bridgeErr error
	for !localDone || !remoteDone {
		completed := <-result
		if completed.local {
			localDone = true
		} else {
			remoteDone = true
		}
		if completed.err != nil && bridgeErr == nil {
			bridgeErr = completed.err
		}
		if (completed.terminal || completed.err != nil) && !terminated {
			terminated = true
			if localDone {
				_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
			}
			cancel()
			_ = connection.Close()
		}
	}
	if !terminated {
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
		cancel()
		_ = connection.Close()
	}
	return bridgeErr
}

func relayGrant(grant *pb.RelaySignedGrant) *relayv1.SignedGrant {
	if grant == nil {
		return nil
	}
	return &relayv1.SignedGrant{KeyId: grant.KeyId, Payload: grant.Payload, Signature: grant.Signature}
}

func findRelayAssignment(bundle *pb.SyncRelayGrantsCommand, role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	for _, assignment := range bundle.Grants {
		if assignment.Role == role && assignment.OwnerKind == ownerKind && assignment.OwnerId == ownerID {
			return assignment
		}
	}
	return nil
}

func (r *relayTunnelRouter) stop() {
	r.mu.Lock()
	for _, registration := range r.registrations {
		registration.cancel()
	}
	r.registrations = map[string]*relayEndpointRegistration{}
	r.mu.Unlock()
}

func managedDatabaseEnginePort(engine string) (string, error) {
	switch engine {
	case "postgres":
		return "5432", nil
	case "redis":
		return "6379", nil
	case "clickhouse":
		return "8123", nil
	default:
		return "", errors.New("unsupported managed database engine")
	}
}
