package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/grpc"
)

type databaseTunnelSession struct {
	tunnelID  string
	bindingID string
	conn      net.Conn
	inbound   chan []byte
	done      chan struct{}
	once      sync.Once
}

const (
	databaseTunnelMaxSessions           = 128
	databaseTunnelMaxSessionsPerBinding = 16
	databaseTunnelIdleTimeout           = 5 * time.Minute
)

type databaseTunnelTransport struct {
	plugin   *DockerPlugin
	stream   pb.DatabaseTunnel_TunnelClient
	ctx      context.Context
	maxChunk int
	sendMu   sync.Mutex
	mu       sync.Mutex
	sessions map[string]*databaseTunnelSession
	listener net.Listener
}

func (p *DockerPlugin) RunDatabaseTunnel(ctx context.Context, conn *grpc.ClientConn, nodeID string) {
	for ctx.Err() == nil {
		if err := p.runDatabaseTunnel(ctx, conn, nodeID); err != nil && ctx.Err() == nil {
			p.logger.Warn("database tunnel stream disconnected", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (p *DockerPlugin) runDatabaseTunnel(ctx context.Context, conn *grpc.ClientConn, nodeID string) error {
	stream, err := connector.OpenDatabaseTunnelStream(ctx, conn)
	if err != nil {
		return fmt.Errorf("open database tunnel stream: %w", err)
	}
	if err := stream.Send(&pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Hello{Hello: &pb.DatabaseTunnelHello{
		NodeId: nodeID, Capability: databaseTunnelCapability, MaxChunkBytes: databaseTunnelMaxChunkBytes,
	}}}); err != nil {
		return fmt.Errorf("send database tunnel hello: %w", err)
	}
	first, err := stream.Recv()
	if err != nil {
		return fmt.Errorf("receive database tunnel ready: %w", err)
	}
	ready := first.GetReady()
	if ready == nil || ready.GetMaxChunkBytes() <= 0 || ready.GetMaxChunkBytes() > databaseTunnelMaxChunkBytes {
		return errors.New("gateway returned an invalid database tunnel frame limit")
	}
	t := &databaseTunnelTransport{
		plugin: p, stream: stream, ctx: ctx, maxChunk: int(ready.GetMaxChunkBytes()), sessions: make(map[string]*databaseTunnelSession),
	}
	p.databaseTunnelMu.Lock()
	p.databaseTunnel = t
	p.databaseTunnelMu.Unlock()
	defer func() {
		t.shutdown()
		p.databaseTunnelMu.Lock()
		if p.databaseTunnel == t {
			p.databaseTunnel = nil
		}
		p.databaseTunnelMu.Unlock()
	}()

	if p.cfg.Docker.Mode != "databases" {
		if err := t.startListener(); err != nil {
			return err
		}
	}
	return t.run()
}

func (t *databaseTunnelTransport) startListener() error {
	socketPath := filepath.Join(t.plugin.cfg.StateDir, DatabaseTunnelSocketFilename)
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale database tunnel socket: %w", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on database tunnel socket: %w", err)
	}
	// The parent state directory is 0700, while the socket itself must remain
	// usable by a non-root first-party sidecar after Docker bind-mounts it.
	if err := os.Chmod(socketPath, 0666); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return fmt.Errorf("set database tunnel socket permissions: %w", err)
	}
	t.listener = listener
	return nil
}

func (t *databaseTunnelTransport) run() error {
	errCh := make(chan error, 2)
	if t.listener != nil {
		go func() { errCh <- t.acceptLoop() }()
	}
	go func() { errCh <- t.receiveLoop() }()
	select {
	case <-t.ctx.Done():
		return t.ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (t *databaseTunnelTransport) acceptLoop() error {
	for {
		conn, err := t.listener.Accept()
		if err != nil {
			return err
		}
		go t.acceptSidecar(conn)
	}
}

func (t *databaseTunnelTransport) acceptSidecar(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	bindingID, err := readDatabaseTunnelHandshake(conn)
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		_ = conn.Close()
		return
	}
	databaseID, ok := t.plugin.databaseBindings.resolve(bindingID)
	if !ok {
		_ = conn.Close()
		return
	}
	tunnelID, err := newDatabaseTunnelID()
	if err != nil {
		_ = conn.Close()
		return
	}
	session, err := t.addSession(tunnelID, bindingID, conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	if err := t.send(&pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Open{Open: &pb.DatabaseTunnelOpen{
		TunnelId: tunnelID, BindingId: bindingID, ManagedDatabaseId: databaseID,
	}}}); err != nil {
		t.finish(session, nil)
		return
	}
	t.startSession(session)
}

func (t *databaseTunnelTransport) receiveLoop() error {
	for {
		message, err := t.stream.Recv()
		if err != nil {
			return err
		}
		switch payload := message.Payload.(type) {
		case *pb.DatabaseTunnelMessage_Open:
			t.handleRemoteOpen(payload.Open)
		case *pb.DatabaseTunnelMessage_Data:
			t.handleRemoteData(payload.Data)
		case *pb.DatabaseTunnelMessage_Close:
			t.finishMatching(payload.Close.GetTunnelId(), payload.Close.GetBindingId(), nil)
		case *pb.DatabaseTunnelMessage_Error:
			t.finishMatching(payload.Error.GetTunnelId(), payload.Error.GetBindingId(), nil)
		default:
			return errors.New("gateway sent an unsupported database tunnel frame")
		}
	}
}

func (t *databaseTunnelTransport) handleRemoteOpen(open *pb.DatabaseTunnelOpen) {
	if t.plugin.cfg.Docker.Mode != "databases" || open == nil {
		t.sendProtocolError(open, "OPEN_NOT_ALLOWED", "Remote open is not allowed on this node")
		return
	}
	conn, err := t.plugin.databaseManager.dial(t.ctx, open.GetManagedDatabaseId())
	if err != nil {
		t.sendProtocolError(open, "DATABASE_UNAVAILABLE", "Managed database is unavailable")
		return
	}
	session, err := t.addSession(open.GetTunnelId(), open.GetBindingId(), conn)
	if err != nil {
		_ = conn.Close()
		code := "TUNNEL_EXISTS"
		message := "Database tunnel identifier is already active"
		if errors.Is(err, errDatabaseTunnelCapacity) {
			code = "RESOURCE_EXHAUSTED"
			message = "Database tunnel session limit reached"
		}
		t.sendProtocolError(open, code, message)
		return
	}
	t.startSession(session)
}

func (t *databaseTunnelTransport) handleRemoteData(data *pb.DatabaseTunnelData) {
	if data == nil || len(data.GetData()) == 0 || len(data.GetData()) > t.maxChunk {
		if data != nil {
			t.finishMatching(data.GetTunnelId(), data.GetBindingId(), databaseTunnelError(data.GetTunnelId(), data.GetBindingId(), "FRAME_TOO_LARGE", "Database tunnel frame exceeds the negotiated limit"))
		}
		return
	}
	t.mu.Lock()
	session := t.sessions[data.GetTunnelId()]
	t.mu.Unlock()
	if session == nil || session.bindingID != data.GetBindingId() {
		return
	}
	chunk := append([]byte(nil), data.GetData()...)
	t.touchSession(session)
	select {
	case session.inbound <- chunk:
	case <-session.done:
	default:
		t.finish(session, databaseTunnelError(session.tunnelID, session.bindingID, "BACKPRESSURE", "Database tunnel peer is not accepting data"))
	}
}

var errDatabaseTunnelCapacity = errors.New("database tunnel session limit reached")

func (t *databaseTunnelTransport) addSession(tunnelID, bindingID string, conn net.Conn) (*databaseTunnelSession, error) {
	if tunnelID == "" || bindingID == "" {
		return nil, errors.New("database tunnel identifiers are required")
	}
	session := &databaseTunnelSession{
		tunnelID: tunnelID, bindingID: bindingID, conn: conn,
		inbound: make(chan []byte, databaseTunnelQueueDepth), done: make(chan struct{}),
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.sessions[tunnelID]; exists {
		return nil, errors.New("database tunnel identifier already exists")
	}
	if len(t.sessions) >= databaseTunnelMaxSessions {
		return nil, errDatabaseTunnelCapacity
	}
	perBinding := 0
	for _, existing := range t.sessions {
		if existing.bindingID == bindingID {
			perBinding++
		}
	}
	if perBinding >= databaseTunnelMaxSessionsPerBinding {
		return nil, errDatabaseTunnelCapacity
	}
	t.sessions[tunnelID] = session
	t.touchSession(session)
	return session, nil
}

func (t *databaseTunnelTransport) startSession(session *databaseTunnelSession) {
	go t.readLocal(session)
	go t.writeLocal(session)
}

func (t *databaseTunnelTransport) readLocal(session *databaseTunnelSession) {
	buffer := make([]byte, t.maxChunk)
	for {
		n, err := session.conn.Read(buffer)
		if n > 0 {
			t.touchSession(session)
			chunk := append([]byte(nil), buffer[:n]...)
			if sendErr := t.send(&pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Data{Data: &pb.DatabaseTunnelData{
				TunnelId: session.tunnelID, BindingId: session.bindingID, Data: chunk,
			}}}); sendErr != nil {
				t.finish(session, nil)
				return
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				t.finish(session, databaseTunnelClose(session.tunnelID, session.bindingID))
			} else {
				t.finish(session, databaseTunnelError(session.tunnelID, session.bindingID, "LOCAL_IO", "Local database tunnel closed"))
			}
			return
		}
	}
}

func (t *databaseTunnelTransport) writeLocal(session *databaseTunnelSession) {
	for {
		select {
		case <-session.done:
			return
		case data := <-session.inbound:
			if err := writeDatabaseTunnelBytes(session.conn, data); err != nil {
				t.finish(session, databaseTunnelError(session.tunnelID, session.bindingID, "LOCAL_IO", "Local database tunnel closed"))
				return
			}
			t.touchSession(session)
		}
	}
}

func (t *databaseTunnelTransport) touchSession(session *databaseTunnelSession) {
	_ = session.conn.SetDeadline(time.Now().Add(databaseTunnelIdleTimeout))
}

func (t *databaseTunnelTransport) finishMatching(tunnelID, bindingID string, outbound *pb.DatabaseTunnelMessage) {
	t.mu.Lock()
	session := t.sessions[tunnelID]
	t.mu.Unlock()
	if session != nil && session.bindingID == bindingID {
		t.finish(session, outbound)
	}
}

func (t *databaseTunnelTransport) finish(session *databaseTunnelSession, outbound *pb.DatabaseTunnelMessage) {
	session.once.Do(func() {
		t.mu.Lock()
		if t.sessions[session.tunnelID] == session {
			delete(t.sessions, session.tunnelID)
		}
		t.mu.Unlock()
		close(session.done)
		_ = session.conn.Close()
		if outbound != nil {
			_ = t.send(outbound)
		}
	})
}

func (t *databaseTunnelTransport) closeBinding(bindingID string) {
	t.mu.Lock()
	var matches []*databaseTunnelSession
	for _, session := range t.sessions {
		if session.bindingID == bindingID {
			matches = append(matches, session)
		}
	}
	t.mu.Unlock()
	for _, session := range matches {
		t.finish(session, databaseTunnelError(session.tunnelID, session.bindingID, "BINDING_REVOKED", "Database binding was removed"))
	}
}

func (t *databaseTunnelTransport) shutdown() {
	if t.listener != nil {
		_ = t.listener.Close()
		_ = os.Remove(filepath.Join(t.plugin.cfg.StateDir, DatabaseTunnelSocketFilename))
	}
	t.mu.Lock()
	sessions := make([]*databaseTunnelSession, 0, len(t.sessions))
	for _, session := range t.sessions {
		sessions = append(sessions, session)
	}
	t.mu.Unlock()
	for _, session := range sessions {
		t.finish(session, nil)
	}
}

func (t *databaseTunnelTransport) send(message *pb.DatabaseTunnelMessage) error {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	return t.stream.Send(message)
}

func (t *databaseTunnelTransport) sendProtocolError(open *pb.DatabaseTunnelOpen, code, message string) {
	if open == nil {
		return
	}
	_ = t.send(databaseTunnelError(open.GetTunnelId(), open.GetBindingId(), code, message))
}

func databaseTunnelClose(tunnelID, bindingID string) *pb.DatabaseTunnelMessage {
	return &pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Close{Close: &pb.DatabaseTunnelClose{
		TunnelId: tunnelID, BindingId: bindingID,
	}}}
}

func databaseTunnelError(tunnelID, bindingID, code, message string) *pb.DatabaseTunnelMessage {
	return &pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Error{Error: &pb.DatabaseTunnelError{
		TunnelId: tunnelID, BindingId: bindingID, Code: code, Message: message,
	}}}
}

func newDatabaseTunnelID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
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
	if labels[managedDatabaseLabel] != record.ID || labels[managedDatabaseTypeTag] != record.Type {
		return nil, errors.New("managed database container labels do not match its record")
	}
	if inspect.Container.NetworkSettings == nil {
		return nil, errors.New("managed database container network is unavailable")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return nil, errors.New("managed database private network address is unavailable")
	}
	port, err := managedDatabaseEnginePort(record.Type)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	return dialer.DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), port))
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
