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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/logepisode"
	"github.com/wiolett-industries/gateway/daemon-shared/netaccept"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const databaseTunnelIdleTimeout = 5 * time.Minute

var _ lifecycle.RelayPoolTunnelPlugin = (*DockerPlugin)(nil)

type relayTunnelRouter struct {
	plugin        *DockerPlugin
	ctx           context.Context
	conn          *grpc.ClientConn
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
	// restartAck closes once the relay confirmed a RESTARTING renewal (B-13);
	// guarded by the router's mu.
	restartAck chan struct{}
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
	router := &relayTunnelRouter{plugin: p, ctx: ctx, conn: conn, client: relayv1.NewTunnelBrokerClient(conn), targetID: relayInstanceID, registrations: map[string]*relayEndpointRegistration{}, transportReady: make(chan struct{})}
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
	if r.plugin.restartAnnounced.Load() {
		// The relays hold these registrations for the next process (B-13).
		return nil
	}
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

// connected reports a relay whose transport is up. A source tunnel opened on
// a relay whose connection dropped waits for the reconnect, which against a
// relay that stopped answering ends only with the connect timeout.
func (r *relayTunnelRouter) connected() bool {
	return r.conn == nil || r.conn.GetState() == connectivity.Ready
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
	// A registration refused because its grant and the relay's policy do not
	// match yet is retried every relayPolicyCatchUpRetry (jittered) for
	// relayPolicyCatchUpWindow: Gateway pushes the policy to the relays and
	// the grants to the daemons at once, and the slower of the two follows
	// within seconds. Longer than that, the regular backoff applies.
	relayPolicyCatchUpRetry  = 400 * time.Millisecond
	relayPolicyCatchUpWindow = 10 * time.Second
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

// relayPolicyCatchingUp reports a registration the relay refused because the
// grant and its policy do not match yet.
func relayPolicyCatchingUp(err error) bool {
	current, ok := status.FromError(err)
	return ok && current.Code() == codes.PermissionDenied && strings.Contains(current.Message(), "does not match policy")
}

// nextRegistrationRetry is the delay before the next registration attempt.
// mismatchFor is how long consecutive attempts have been refused for a
// policy mismatch.
func nextRegistrationRetry(err error, failures int, mismatchFor time.Duration, random func() float64) time.Duration {
	if relayPolicyCatchingUp(err) && mismatchFor < relayPolicyCatchUpWindow {
		return relayPolicyCatchUpRetry/2 + time.Duration(random()*float64(relayPolicyCatchUpRetry/2))
	}
	return relayRegistrationRetryDelay(failures, random)
}

func (r *relayTunnelRouter) runRegistration(ctx context.Context, update relayRegistrationUpdate, renew <-chan relayRegistrationUpdate) {
	current, state := update.assignment, update.state
	failures := 0
	var mismatchSince time.Time
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
						registered, failures, mismatchSince = true, 0, time.Time{}
						log("relay endpoint registered", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId, "state", state.String())
						r.mu.Lock()
						if registration := r.registrations[relayRegistrationKey(current)]; registration != nil {
							registration.ready.Store(true)
							if state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING && registration.restartAck != nil {
								close(registration.restartAck)
								registration.restartAck = nil
							}
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
		mismatchFor := time.Duration(0)
		if relayPolicyCatchingUp(err) {
			if mismatchSince.IsZero() {
				mismatchSince = time.Now()
			}
			mismatchFor = time.Since(mismatchSince)
		} else {
			mismatchSince = time.Time{}
		}
		delay := nextRegistrationRetry(err, failures, mismatchFor, rand.Float64)
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
		r.tunnelFailed(assignment, "accept", err)
		return
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: incoming.AcceptToken}}}); err != nil {
		r.tunnelFailed(assignment, "authorize", err)
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		if err == nil {
			err = errors.New("relay sent no ready frame")
		}
		r.tunnelFailed(assignment, "ready", err)
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
		if err == nil {
			// Tracked so a restart finishes the request in flight and closes
			// the tunnel once it is idle (B-13).
			tracked := newDrainConn(connection)
			connection = tracked
			defer r.plugin.proxyTunnels.add(tracked, cancel)()
		}
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
		r.tunnelFailed(assignment, "dial", err)
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "endpoint_unavailable", Message: "Endpoint is unavailable"}}})
		return
	}
	defer connection.Close()
	r.plugin.relayTunnelOutcomes.Succeeded(r.plugin.logger, relayTunnelOutcome(assignment))
	if assignment.OwnerKind == proxySecureLinkOwnerKind {
		readChunk := int(r.plugin.relayGrants.readChunkBytes())
		if readChunk == 0 {
			readChunk = relaybridge.DefaultChunkBytes
		}
		_ = relaybridge.BridgeWithChunk(tunnelCtx, connection, stream, int(first.GetReady().MaxFrameBytes), readChunk, cancel)
		return
	}
	_ = bridgeRelayConnection(connection, stream, int(first.GetReady().MaxFrameBytes), cancel)
}

// relayTunnelOutcome keys the outcome log of incoming tunnels by endpoint owner (L-1): while a workload is down,
// or its relay path breaks, every request through it fails here, one WARN line each.
func relayTunnelOutcome(assignment *pb.RelayGrantAssignment) logepisode.Subject {
	return logepisode.Subject{Name: "relay endpoint tunnels", IDAttr: "owner_id", ID: assignment.OwnerId}
}

// tunnelFailed logs a failed incoming tunnel at debug and reports it per owner and state change.
func (r *relayTunnelRouter) tunnelFailed(assignment *pb.RelayGrantAssignment, stage string, err error) {
	r.plugin.logger.Debug("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId,
		"relay_instance_id", r.targetID, "stage", stage, "error", err)
	r.plugin.relayTunnelOutcomes.Failed(r.plugin.logger, relayTunnelOutcome(assignment), "owner_kind", assignment.OwnerKind,
		"relay_instance_id", r.targetID, "stage", stage, "error", err.Error())
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
	// The socket the previous process handed over keeps the connections the sidecars made meanwhile.
	if listener, keptName := adoptKeptUnixListener(path, databaseTunnelSocketFits); listener != nil {
		p.relayListener = listener
		p.relayListenerKept.set(listener, keptName)
		go p.acceptRelayLoop(listener)
		return nil
	}
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
	p.relayListenerKept.set(listener, keepUnixListener(listener, path))
	go p.acceptRelayLoop(listener)
	return nil
}

// databaseTunnelSocketFits reports whether the sidecar socket file is open to every sidecar (0666), as created.
func databaseTunnelSocketFits(info os.FileInfo) bool {
	return info.Mode().Perm() == 0o666
}

func (p *DockerPlugin) acceptRelayLoop(listener net.Listener) {
	// A transient accept error (out of descriptors) must not end the loop.
	netaccept.Serve(listener, nil, p.openSidecar)
}

func (p *DockerPlugin) openSidecar(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	bindingID, err := readDatabaseTunnelHandshake(connection)
	_ = connection.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	// A binding served through a legacy sidecar has no host listener: the link is held at its limit here.
	if assignment := p.relayGrants.lookup("connect", linkKindManagedDatabaseBinding, bindingID); assignment != nil {
		link := linkKey{kind: linkKindManagedDatabaseBinding, id: bindingID}
		limit := relayGrantSessionLimit(assignment, managedLinkDefaultSessions)
		if !p.linkConnections.acquire(link, int(limit)) {
			p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedLinkLimit, "limit", limit)
			return
		}
		defer p.linkConnections.release(link)
	}
	p.openManagedDatabaseBinding(connection, bindingID, 0)
}

func (p *DockerPlugin) openManagedDatabaseBinding(connection net.Conn, bindingID string, routeGeneration uint64) {
	assignment := p.relayGrants.lookup("connect", "managed_database_binding", bindingID)
	if assignment == nil {
		p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedGrantUnavailable)
		return
	}
	if routeGeneration != 0 {
		listener := assignment.GetManagedDatabaseListener()
		if listener == nil || listener.GetRouteGeneration() != routeGeneration {
			p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedRouteChanged)
			return
		}
	}
	tunnel, err := p.openRelaySource(assignment)
	if err != nil {
		p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, relayRefusalReason(err),
			"error", relayRefusalMessage(err))
		return
	}
	// Tracked so a restart lets the request in flight finish (link_listener_handover.go).
	flow, done := p.linkFlows.track(connection)
	defer done()
	tunnel.bridge(p.linkTraffic.carry(linkKey{kind: linkKindManagedDatabaseBinding, id: bindingID}, flow))
}

// openRelaySource opens a source tunnel for assignment on the first of its relay candidates (in load and latency
// order) that accepts it. When none does, the error is a capacity refusal if any relay gave one (the relay's own
// reason), else the last refusal. Right after this process started, a connection that finds no relay lane waits for
// the first lanes (relayLaneStartupWait): the link sockets the previous process handed over are served before the
// lanes are up.
func (p *DockerPlugin) openRelaySource(assignment *pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	for {
		tunnel, err := p.openRelaySourceOnce(assignment)
		if err == nil || !errors.Is(err, errRelayLaneUnavailable) || !p.waitForRelayLanes() {
			return tunnel, err
		}
	}
}

func (p *DockerPlugin) openRelaySourceOnce(assignment *pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.GetGrant()}}
	}
	refusal := errRelayLaneUnavailable
	for _, candidate := range p.orderRelayCandidates(candidates) {
		router := p.relayRouter(candidate.GetRelayInstanceId())
		if router == nil {
			continue
		}
		tunnel, err := router.openSource(candidate.GetGrant())
		if err == nil {
			return tunnel, nil
		}
		if relayRefusalReason(refusal) != linkRejectedRelayCapacity {
			refusal = err
		}
	}
	return nil, refusal
}

func (p *DockerPlugin) orderRelayCandidates(candidates []*pb.RelayDataCandidate) []*pb.RelayDataCandidate {
	if len(candidates) < 2 {
		return append([]*pb.RelayDataCandidate(nil), candidates...)
	}
	p.relayTunnelMu.Lock()
	transports := make(map[string]relaybridge.TransportLoad, len(p.relayTunnels))
	for targetID, router := range p.relayTunnels {
		transports[targetID] = relaybridge.TransportLoad{Available: router.connected(), Active: router.active.Load()}
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
	assignment := p.relayGrants.lookup("connect", ownerKind, routeID)
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
		var backoff netaccept.Backoff
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				if routeCtx.Err() == nil && backoff.Retry(acceptErr, routeCtx.Done()) {
					continue
				}
				return
			}
			backoff.Reset()
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
				current := p.relayGrants.lookup("connect", ownerKind, routeID)
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

// openSourceTunnel opens a source tunnel with grant and bridges connection over it until either side ends it. It
// reports false, before any data moved, when the relay did not admit the tunnel.
func (r *relayTunnelRouter) openSourceTunnel(connection net.Conn, grant *pb.RelaySignedGrant) bool {
	tunnel, err := r.openSource(grant)
	if err != nil {
		return false
	}
	tunnel.bridge(connection)
	return true
}

// relaySourceTunnel is a source tunnel the relay admitted, before it carries any data.
type relaySourceTunnel struct {
	router   *relayTunnelRouter
	stream   relayFrameStream
	cancel   context.CancelFunc
	maxFrame int
}

// openSource opens a source tunnel with grant and waits until the relay admits it. A refusal (the route's or
// endpoint's session capacity, a revoked or stale grant) is the relay's status error.
func (r *relayTunnelRouter) openSource(grant *pb.RelaySignedGrant) (*relaySourceTunnel, error) {
	tunnelCtx, cancel := context.WithCancel(r.ctx)
	stream, err := r.client.OpenTunnel(tunnelCtx)
	if err == nil {
		err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}})
	}
	var first *relayv1.TunnelFrame
	if err == nil {
		first, err = stream.Recv()
	}
	if err == nil && first.GetReady() == nil {
		err = errors.New("relay sent no ready frame")
		if relayErr := first.GetError(); relayErr != nil {
			err = fmt.Errorf("relay tunnel error: %s", relayErr.GetCode())
		}
	}
	if err != nil {
		cancel()
		return nil, err
	}
	return &relaySourceTunnel{router: r, stream: stream, cancel: cancel, maxFrame: int(first.GetReady().MaxFrameBytes)}, nil
}

// bridge carries connection over the tunnel until either side ends it.
func (t *relaySourceTunnel) bridge(connection net.Conn) {
	defer t.cancel()
	t.router.active.Add(1)
	defer t.router.active.Add(-1)
	_ = bridgeRelayConnection(connection, t.stream, t.maxFrame, t.cancel)
}

// close abandons a tunnel that was never bridged.
func (t *relaySourceTunnel) close() {
	t.cancel()
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
			if err == nil || relaybridge.ProbeReachedGatedEndpoint(err) {
				// A route gated by an Availability lease (a standby source or
				// target) still proves the relay authorizes it (B-17).
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
