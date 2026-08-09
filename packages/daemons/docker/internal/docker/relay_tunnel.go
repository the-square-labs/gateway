package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

const databaseTunnelIdleTimeout = 5 * time.Minute

type relayTunnelRouter struct {
	plugin        *DockerPlugin
	ctx           context.Context
	client        relayv1.TunnelBrokerClient
	mu            sync.Mutex
	registrations map[string]*relayEndpointRegistration
	listener      net.Listener
}

type relayEndpointRegistration struct {
	cancel context.CancelFunc
	renew  chan *pb.RelayGrantAssignment
}

func (p *DockerPlugin) RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, _ string) {
	router := &relayTunnelRouter{plugin: p, ctx: ctx, client: relayv1.NewTunnelBrokerClient(conn), registrations: map[string]*relayEndpointRegistration{}}
	p.relayTunnelMu.Lock()
	p.relayTunnel = router
	p.relayTunnelMu.Unlock()
	defer func() {
		router.stop()
		p.relayTunnelMu.Lock()
		if p.relayTunnel == router {
			p.relayTunnel = nil
		}
		p.relayTunnelMu.Unlock()
	}()
	if p.cfg.Docker.Mode != "databases" {
		if err := router.startListener(); err != nil {
			p.logger.Warn("relay tunnel listener failed", "error", err)
			return
		}
	}
	router.reconcileRegistrations()
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.relayGrants.changed:
			router.reconcileRegistrations()
		}
	}
}

func (r *relayTunnelRouter) reconcileRegistrations() {
	bundle := r.plugin.relayGrants.get()
	desired := map[string]*pb.RelayGrantAssignment{}
	if r.plugin.cfg.Docker.Mode == "databases" {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && assignment.EndpointId != "" {
				desired[assignment.EndpointId] = assignment
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
	r.mu.Unlock()
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
					if incoming := message.GetIncoming(); incoming != nil {
						go r.acceptIncoming(r.ctx, current, incoming)
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
	if r.plugin.databaseManager == nil {
		return
	}
	tunnelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := r.client.AcceptTunnel(tunnelCtx)
	if err != nil {
		return
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: incoming.AcceptToken}}}); err != nil {
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		return
	}
	connection, err := r.plugin.databaseManager.dial(ctx, assignment.OwnerId)
	if err != nil {
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "endpoint_unavailable", Message: "Managed endpoint is unavailable"}}})
		return
	}
	defer connection.Close()
	_ = bridgeRelayConnection(connection, stream, int(first.GetReady().MaxFrameBytes), cancel)
}

func (r *relayTunnelRouter) startListener() error {
	if err := prepareDatabaseTunnelSocketDirectory(r.plugin.cfg.StateDir); err != nil {
		return err
	}
	path := databaseTunnelSocketPath(r.plugin.cfg.StateDir)
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
	r.listener = listener
	go r.acceptLoop()
	return nil
}

func (r *relayTunnelRouter) acceptLoop() {
	for {
		connection, err := r.listener.Accept()
		if err != nil {
			return
		}
		go r.openSidecar(connection)
	}
}

func (r *relayTunnelRouter) openSidecar(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	bindingID, err := readDatabaseTunnelHandshake(connection)
	_ = connection.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	assignment := findRelayAssignment(r.plugin.relayGrants.get(), "connect", "managed_database_binding", bindingID)
	if assignment == nil {
		return
	}
	tunnelCtx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	stream, err := r.client.OpenTunnel(tunnelCtx)
	if err != nil {
		return
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(assignment.Grant)}}}); err != nil {
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		return
	}
	_ = bridgeRelayConnection(connection, stream, int(first.GetReady().MaxFrameBytes), cancel)
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
	if r.listener != nil {
		_ = r.listener.Close()
		_ = os.Remove(databaseTunnelSocketPath(r.plugin.cfg.StateDir))
	}
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
