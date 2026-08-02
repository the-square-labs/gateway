package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
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
	plugin    *DockerPlugin
	stream    pb.DatabaseTunnel_TunnelClient
	ctx       context.Context
	lane      string
	bindingID string
	maxChunk  int
	sendMu    sync.Mutex
	mu        sync.Mutex
	sessions  map[string]*databaseTunnelSession
}

type databaseTunnelSlot struct {
	cancel    context.CancelFunc
	ready     chan struct{}
	readyOnce sync.Once
	transport *databaseTunnelTransport
}

// databaseTunnelRouter owns isolated logical streams over the daemon's shared
// mTLS gRPC connection. Data is isolated per application binding; Gateway
// interactive work and monitoring each use their own lane.
type databaseTunnelRouter struct {
	plugin *DockerPlugin
	ctx    context.Context
	conn   *grpc.ClientConn
	nodeID string

	mu       sync.Mutex
	listener net.Listener
	slots    map[string]*databaseTunnelSlot
	once     sync.Once
}

func (p *DockerPlugin) RunDatabaseTunnel(ctx context.Context, conn *grpc.ClientConn, nodeID string) {
	router := &databaseTunnelRouter{plugin: p, ctx: ctx, conn: conn, nodeID: nodeID, slots: make(map[string]*databaseTunnelSlot)}
	p.databaseTunnelMu.Lock()
	p.databaseTunnel = router
	p.databaseTunnelMu.Unlock()
	defer func() {
		router.shutdown()
		p.databaseTunnelMu.Lock()
		if p.databaseTunnel == router {
			p.databaseTunnel = nil
		}
		p.databaseTunnelMu.Unlock()
	}()
	router.run()
}

func (r *databaseTunnelRouter) run() {
	if r.plugin.cfg.Docker.Mode != "databases" {
		if err := r.startListener(); err != nil {
			r.plugin.logger.Warn("database tunnel listener failed", "error", err)
			return
		}
	}
	if r.plugin.cfg.Docker.Mode == "databases" {
		r.startLane("interactive", "")
		r.startLane("monitoring", "")
	}
	for bindingID := range r.plugin.databaseBindings.list() {
		r.startLane("data", bindingID)
	}
	<-r.ctx.Done()
}

func (p *DockerPlugin) ensureDatabaseBindingTunnel(bindingID string) error {
	p.databaseTunnelMu.Lock()
	router := p.databaseTunnel
	p.databaseTunnelMu.Unlock()
	if router == nil {
		return errors.New("database tunnel is not connected")
	}
	return router.ensureBinding(bindingID)
}

func (r *databaseTunnelRouter) ensureBinding(bindingID string) error {
	slot := r.startLane("data", bindingID)
	select {
	case <-slot.ready:
		if r.transportForBinding(bindingID) != nil {
			return nil
		}
		return errors.New("database binding tunnel is reconnecting")
	case <-r.ctx.Done():
		return r.ctx.Err()
	case <-time.After(10 * time.Second):
		return errors.New("timed out waiting for database binding tunnel")
	}
}

func (r *databaseTunnelRouter) startLane(lane, bindingID string) *databaseTunnelSlot {
	key := databaseTunnelLaneKey(lane, bindingID)
	r.mu.Lock()
	if slot := r.slots[key]; slot != nil {
		r.mu.Unlock()
		return slot
	}
	ctx, cancel := context.WithCancel(r.ctx)
	slot := &databaseTunnelSlot{cancel: cancel, ready: make(chan struct{})}
	r.slots[key] = slot
	r.mu.Unlock()
	go r.runLane(ctx, slot, lane, bindingID)
	return slot
}

func databaseTunnelLaneKey(lane, bindingID string) string {
	if lane == "data" {
		return "data:" + bindingID
	}
	return lane
}

func databaseTunnelCapability(lane, bindingID string) string {
	if lane == "data" {
		return databaseTunnelCapabilityPrefix + "data:" + bindingID
	}
	return databaseTunnelCapabilityPrefix + lane
}

func (r *databaseTunnelRouter) transportForBinding(bindingID string) *databaseTunnelTransport {
	r.mu.Lock()
	defer r.mu.Unlock()
	slot := r.slots[databaseTunnelLaneKey("data", bindingID)]
	if slot == nil {
		return nil
	}
	return slot.transport
}

func (r *databaseTunnelRouter) closeBinding(bindingID string) {
	key := databaseTunnelLaneKey("data", bindingID)
	r.mu.Lock()
	slot := r.slots[key]
	var transport *databaseTunnelTransport
	if slot != nil {
		transport = slot.transport
		delete(r.slots, key)
	}
	r.mu.Unlock()
	if slot == nil {
		return
	}
	if transport != nil {
		transport.closeBinding(bindingID)
	}
	slot.cancel()
}

func (r *databaseTunnelRouter) shutdown() {
	r.once.Do(func() {
		if r.listener != nil {
			_ = r.listener.Close()
			_ = os.Remove(filepath.Join(r.plugin.cfg.StateDir, DatabaseTunnelSocketFilename))
		}
		r.mu.Lock()
		slots := make([]*databaseTunnelSlot, 0, len(r.slots))
		transports := make([]*databaseTunnelTransport, 0, len(r.slots))
		for _, slot := range r.slots {
			slots = append(slots, slot)
			if slot.transport != nil {
				transports = append(transports, slot.transport)
			}
		}
		r.slots = make(map[string]*databaseTunnelSlot)
		r.mu.Unlock()
		for _, transport := range transports {
			transport.shutdown()
		}
		for _, slot := range slots {
			slot.cancel()
		}
	})
}

func (r *databaseTunnelRouter) runLane(ctx context.Context, slot *databaseTunnelSlot, lane, bindingID string) {
	for ctx.Err() == nil {
		err := r.runTransport(ctx, slot, lane, bindingID)
		if err != nil && ctx.Err() == nil {
			r.plugin.logger.Warn("database tunnel lane disconnected", "lane", lane, "binding_id", bindingID, "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (r *databaseTunnelRouter) runTransport(
	ctx context.Context,
	slot *databaseTunnelSlot,
	lane, bindingID string,
) error {
	stream, err := connector.OpenDatabaseTunnelStream(ctx, r.conn)
	if err != nil {
		return fmt.Errorf("open database tunnel stream: %w", err)
	}
	if err := stream.Send(&pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Hello{Hello: &pb.DatabaseTunnelHello{
		NodeId: r.nodeID, Capability: databaseTunnelCapability(lane, bindingID), MaxChunkBytes: databaseTunnelMaxChunkBytes,
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
		plugin: r.plugin, stream: stream, ctx: ctx, lane: lane, bindingID: bindingID,
		maxChunk: int(ready.GetMaxChunkBytes()), sessions: make(map[string]*databaseTunnelSession),
	}
	defer func() {
		t.shutdown()
		r.mu.Lock()
		if slot.transport == t {
			slot.transport = nil
		}
		r.mu.Unlock()
	}()
	r.mu.Lock()
	slot.transport = t
	r.mu.Unlock()
	slot.readyOnce.Do(func() { close(slot.ready) })
	return t.run()
}

func (r *databaseTunnelRouter) startListener() error {
	socketPath := filepath.Join(r.plugin.cfg.StateDir, DatabaseTunnelSocketFilename)
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
	r.listener = listener
	go r.acceptLoop()
	return nil
}

func (t *databaseTunnelTransport) run() error {
	return t.receiveLoop()
}

func (r *databaseTunnelRouter) acceptLoop() {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}
		go r.acceptSidecar(conn)
	}
}

func (r *databaseTunnelRouter) acceptSidecar(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	bindingID, err := readDatabaseTunnelHandshake(conn)
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		_ = conn.Close()
		return
	}
	databaseID, ok := r.plugin.databaseBindings.resolve(bindingID)
	if !ok {
		_ = conn.Close()
		return
	}
	tunnelID, err := newDatabaseTunnelID()
	if err != nil {
		_ = conn.Close()
		return
	}
	transport := r.transportForBinding(bindingID)
	if transport == nil {
		_ = conn.Close()
		return
	}
	session, err := transport.addSession(tunnelID, bindingID, conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	if err := transport.send(&pb.DatabaseTunnelMessage{Payload: &pb.DatabaseTunnelMessage_Open{Open: &pb.DatabaseTunnelOpen{
		TunnelId: tunnelID, BindingId: bindingID, ManagedDatabaseId: databaseID,
	}}}); err != nil {
		transport.finish(session, nil)
		return
	}
	transport.startSession(session)
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
	if t.lane == "data" && t.bindingID != open.GetBindingId() {
		t.sendProtocolError(open, "BINDING_NOT_AUTHORIZED", "Database tunnel binding does not match this stream")
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
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), port))
	if err != nil {
		return nil, err
	}
	if record.Type != "postgres" || !record.TLSEnabled {
		return connection, nil
	}
	return m.startPostgresTLS(ctx, connection, record)
}

// PostgreSQL upgrades TCP connections through its SSLRequest preface rather
// than beginning with a TLS ClientHello. The private Gateway tunnel remains
// opaque to workloads, but this hop must use TLS when pg_hba.conf requires
// TLS for all TCP clients.
func (m *managedDatabaseManager) startPostgresTLS(
	ctx context.Context,
	connection net.Conn,
	record managedDatabaseRecord,
) (net.Conn, error) {
	config, err := m.postgresTLSClientConfig(record)
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("set PostgreSQL TLS deadline: %w", err)
	}
	var request [8]byte
	binary.BigEndian.PutUint32(request[:4], 8)
	binary.BigEndian.PutUint32(request[4:], 80877103)
	if _, err := connection.Write(request[:]); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("request PostgreSQL TLS: %w", err)
	}
	var response [1]byte
	if _, err := io.ReadFull(connection, response[:]); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("read PostgreSQL TLS response: %w", err)
	}
	if response[0] != 'S' {
		_ = connection.Close()
		return nil, errors.New("PostgreSQL server rejected TLS")
	}
	tlsConnection := tls.Client(connection, config)
	if err := tlsConnection.HandshakeContext(ctx); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("negotiate PostgreSQL TLS: %w", err)
	}
	if err := tlsConnection.SetDeadline(time.Time{}); err != nil {
		_ = tlsConnection.Close()
		return nil, fmt.Errorf("clear PostgreSQL TLS deadline: %w", err)
	}
	return tlsConnection, nil
}

func (m *managedDatabaseManager) postgresTLSClientConfig(record managedDatabaseRecord) (*tls.Config, error) {
	tlsDir := m.tlsDirectory(record)
	certificatePEM, err := os.ReadFile(filepath.Join(tlsDir, "cert.pem"))
	if err != nil {
		return nil, fmt.Errorf("read managed PostgreSQL certificate: %w", err)
	}
	certificateBlock, _ := pem.Decode(certificatePEM)
	if certificateBlock == nil {
		return nil, errors.New("parse managed PostgreSQL certificate")
	}
	expectedCertificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse managed PostgreSQL certificate: %w", err)
	}
	caPEM, err := os.ReadFile(filepath.Join(tlsDir, "ca.pem"))
	if err != nil {
		return nil, fmt.Errorf("read managed PostgreSQL CA certificate: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("parse managed PostgreSQL CA certificate")
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		RootCAs:            roots,
		InsecureSkipVerify: true, // Verified below against this database's exact certificate and Gateway CA.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("PostgreSQL TLS server did not present a certificate")
			}
			peer := state.PeerCertificates[0]
			if !bytes.Equal(peer.Raw, expectedCertificate.Raw) {
				return errors.New("PostgreSQL TLS server certificate does not match the managed database")
			}
			_, err := peer.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
			return err
		},
	}, nil
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
