package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
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
	listener      net.Listener
	active        atomic.Int64
}

type relayEndpointRegistration struct {
	cancel context.CancelFunc
	renew  chan *pb.RelayGrantAssignment
	ready  atomic.Bool
}

func (p *DockerPlugin) RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, _ string) {
	p.RunRelayTargetTunnels(ctx, conn, "", relaybridge.LegacyTargetID)
}

func (p *DockerPlugin) RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, _ string, relayInstanceID string) {
	router := &relayTunnelRouter{plugin: p, ctx: ctx, client: relayv1.NewTunnelBrokerClient(conn), targetID: relayInstanceID, registrations: map[string]*relayEndpointRegistration{}}
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
	if p.cfg.Docker.Mode != "databases" {
		if err := p.startRelayListener(); err != nil {
			p.logger.Warn("relay tunnel listener failed", "error", err)
			return
		}
	}
	router.reconcileRegistrations()
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

func (r *relayTunnelRouter) reconcileRegistrations() {
	bundle := r.plugin.relayGrants.get()
	desired := map[string]*pb.RelayGrantAssignment{}
	if r.plugin.cfg.Docker.Mode == "databases" {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && assignment.OwnerKind == "managed_database" && assignment.EndpointId != "" {
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = projected
				}
			}
		}
	} else {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && assignment.OwnerKind == proxySecureLinkOwnerKind && assignment.EndpointId != "" {
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = projected
				}
			}
		}
	}
	r.mu.Lock()
	for id, registration := range r.registrations {
		assignment := desired[id]
		if assignment == nil {
			registration.cancel()
			delete(r.registrations, id)
			continue
		}
		queueLatestRelayGrant(registration.renew, assignment)
		delete(desired, id)
	}
	for id, assignment := range desired {
		ctx, cancel := context.WithCancel(r.ctx)
		registration := &relayEndpointRegistration{cancel: cancel, renew: make(chan *pb.RelayGrantAssignment, 1)}
		r.registrations[id] = registration
		go r.runRegistration(ctx, assignment, registration.renew)
	}
	r.plugin.logger.Info("relay endpoint registrations reconciled", "relay_instance_id", r.targetID, "registrations", len(r.registrations))
	r.mu.Unlock()
}

func (p *DockerPlugin) reconcileRelayRegistrations() {
	p.relayTunnelMu.Lock()
	routers := make([]*relayTunnelRouter, 0, len(p.relayTunnels))
	for _, router := range p.relayTunnels {
		if router != nil {
			routers = append(routers, router)
		}
	}
	p.relayTunnelMu.Unlock()
	for _, router := range routers {
		router.reconcileRegistrations()
	}
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

func queueLatestRelayGrant(target chan *pb.RelayGrantAssignment, assignment *pb.RelayGrantAssignment) {
	select {
	case target <- assignment:
		return
	default:
	}
	select {
	case <-target:
	default:
	}
	select {
	case target <- assignment:
	default:
	}
}

func (r *relayTunnelRouter) runRegistration(ctx context.Context, assignment *pb.RelayGrantAssignment, renew <-chan *pb.RelayGrantAssignment) {
	current := assignment
	for ctx.Err() == nil {
		attemptCtx, cancelAttempt := context.WithCancel(ctx)
		stream, err := r.client.RegisterEndpoint(attemptCtx)
		if err == nil {
			err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{Grant: relayGrant(current.Grant)}}})
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
					current = next
					err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{Grant: relayGrant(current.Grant)}}})
				case message := <-received:
					if message.GetRegistered() != nil {
						r.plugin.logger.Info("relay endpoint registered", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId)
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
		r.plugin.logger.Warn("relay endpoint registration disconnected", "endpoint_id", current.EndpointId, "error", err)
		retry := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			retry.Stop()
			return
		case next := <-renew:
			if !retry.Stop() {
				<-retry.C
			}
			current = next
		case <-retry.C:
		}
	}
}

func (r *relayTunnelRouter) acceptIncoming(ctx context.Context, assignment *pb.RelayGrantAssignment, incoming *relayv1.IncomingTunnel) {
	tunnelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
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
		connection, err = r.plugin.databaseManager.dial(ctx, assignment.OwnerId)
	case proxySecureLinkOwnerKind:
		if r.plugin.secureLinks == nil {
			return
		}
		connection, err = r.plugin.secureLinks.dial(ctx, assignment.OwnerId)
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
	ordered := append([]*pb.RelayDataCandidate(nil), candidates...)
	if len(ordered) < 2 {
		return ordered
	}
	p.relayTunnelMu.Lock()
	loads := make(map[string]int64, len(ordered))
	available := make(map[string]bool, len(ordered))
	for targetID, router := range p.relayTunnels {
		available[targetID] = true
		loads[targetID] = router.active.Load()
	}
	start := int(p.relaySelection % uint64(len(ordered)))
	p.relaySelection++
	p.relayTunnelMu.Unlock()
	rank := make(map[string]int, len(ordered))
	for offset := range ordered {
		candidate := ordered[(start+offset)%len(ordered)]
		rank[candidate.GetRelayInstanceId()] = offset
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		leftID, rightID := ordered[i].GetRelayInstanceId(), ordered[j].GetRelayInstanceId()
		if available[leftID] != available[rightID] {
			return available[leftID]
		}
		if loads[leftID] != loads[rightID] {
			return loads[leftID] < loads[rightID]
		}
		return rank[leftID] < rank[rightID]
	})
	return ordered
}

func (p *DockerPlugin) relayRouter(targetID string) *relayTunnelRouter {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	return p.relayTunnels[targetID]
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
				if tcp, ok := connection.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
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

func (m *managedDatabaseManager) dial(ctx context.Context, managedDatabaseID string) (net.Conn, error) {
	if !managedDatabaseIDPattern.MatchString(managedDatabaseID) {
		return nil, errors.New("invalid managed database id")
	}
	m.mu.Lock()
	record, err := m.loadRecord(managedDatabaseID)
	m.mu.Unlock()
	if err != nil || record.ID != managedDatabaseID {
		return nil, errors.New("managed database record not found")
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.Config == nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return nil, errors.New("managed database container is unavailable")
	}
	labels := inspect.Container.Config.Labels
	if labels[managedDatabaseLabel] != record.ID || labels[managedDatabaseTypeTag] != record.Type || inspect.Container.NetworkSettings == nil {
		return nil, errors.New("managed database container identity is invalid")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return nil, errors.New("managed database private network is unavailable")
	}
	port, err := managedDatabaseEnginePort(record.Type)
	if err != nil {
		return nil, err
	}
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), port))
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
