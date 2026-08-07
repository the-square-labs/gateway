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

	mobymount "github.com/moby/moby/api/types/mount"
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
			_ = os.Remove(databaseTunnelSocketPath(r.plugin.cfg.StateDir))
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
	if err := prepareDatabaseTunnelSocketDirectory(r.plugin.cfg.StateDir); err != nil {
		return err
	}
	socketPath := databaseTunnelSocketPath(r.plugin.cfg.StateDir)
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale database tunnel socket: %w", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on database tunnel socket: %w", err)
	}
	// Only this dedicated directory is exposed read-only to the first-party
	// connector. The socket itself must be usable by its non-root process.
	if err := os.Chmod(socketPath, 0666); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return fmt.Errorf("set database tunnel socket permissions: %w", err)
	}
	r.listener = listener
	go r.acceptLoop()
	return nil
}

func prepareDatabaseTunnelSocketDirectory(stateDir string) error {
	socketDirectory := filepath.Join(stateDir, DatabaseTunnelSocketDirectory)
	if err := os.MkdirAll(socketDirectory, 0755); err != nil {
		return fmt.Errorf("create database tunnel socket directory: %w", err)
	}
	if err := os.Chmod(socketDirectory, 0755); err != nil {
		return fmt.Errorf("set database tunnel socket directory permissions: %w", err)
	}
	return nil
}

func databaseTunnelSocketPath(stateDir string) string {
	return filepath.Join(stateDir, DatabaseTunnelSocketDirectory, DatabaseTunnelSocketFilename)
}

func legacyDatabaseTunnelSocketPath(stateDir string) string {
	return filepath.Join(stateDir, legacyDatabaseTunnelSocketFilename)
}

// reconcileLegacyDatabaseConnectorMounts performs the one-time upgrade from
// the old socket-file bind to the restart-safe directory bind. Only
// first-party connector containers with the exact legacy bind are recreated.
func (p *DockerPlugin) reconcileLegacyDatabaseConnectorMounts(ctx context.Context) (int, error) {
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		return 0, fmt.Errorf("list connector containers: %w", err)
	}

	migrated := 0
	for _, candidate := range containers {
		if candidate.Labels[databaseConnectorLabel] != "true" {
			continue
		}
		changed, migrateErr := p.migrateLegacyDatabaseConnectorMount(ctx, candidate.ID)
		if migrateErr != nil {
			return migrated, fmt.Errorf("migrate connector %s: %w", candidate.ID, migrateErr)
		}
		if changed {
			migrated++
		}
	}
	return migrated, nil
}

func (p *DockerPlugin) migrateLegacyDatabaseConnectorMount(ctx context.Context, containerID string) (bool, error) {
	inspectResult, err := p.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return false, fmt.Errorf("inspect container: %w", err)
	}
	inspect := inspectResult.Container
	if inspect.Config == nil || inspect.Config.Labels[databaseConnectorLabel] != "true" {
		return false, nil
	}
	if inspect.HostConfig == nil {
		return false, errors.New("connector host configuration is unavailable")
	}

	binds, bindsChanged := replaceLegacyDatabaseConnectorBinds(p.cfg.StateDir, inspect.HostConfig.Binds)
	mounts, mountsChanged := replaceLegacyDatabaseConnectorMounts(p.cfg.StateDir, inspect.HostConfig.Mounts)
	if !bindsChanged && !mountsChanged {
		return false, nil
	}
	rollback, err := cloneInspectResponse(&inspect)
	if err != nil {
		return false, fmt.Errorf("snapshot connector for rollback: %w", err)
	}
	inspect.HostConfig.Binds = binds
	inspect.HostConfig.Mounts = mounts
	imageReference := inspect.Config.Image
	if imageReference == "" {
		imageReference = inspect.Image
	}
	if imageReference == "" {
		return false, errors.New("connector image reference is unavailable")
	}
	if err := p.client.recreateContainer(ctx, &inspect, imageReference, nil, nil, rollback); err != nil {
		return false, err
	}
	return true, nil
}

func replaceLegacyDatabaseConnectorMounts(stateDir string, mounts []mobymount.Mount) ([]mobymount.Mount, bool) {
	legacySocket := legacyDatabaseTunnelSocketPath(stateDir)
	replacementDirectory := filepath.Join(stateDir, DatabaseTunnelSocketDirectory)
	updated := append([]mobymount.Mount(nil), mounts...)
	changed := false
	for index, mounted := range updated {
		if mounted.Type == mobymount.TypeBind && mounted.Source == legacySocket && mounted.Target == databaseConnectorSocketPath {
			updated[index].Source = replacementDirectory
			updated[index].Target = databaseConnectorSocketDirectory
			updated[index].ReadOnly = true
			changed = true
		}
	}
	return updated, changed
}

func replaceLegacyDatabaseConnectorBinds(stateDir string, binds []string) ([]string, bool) {
	legacyBind := legacyDatabaseTunnelSocketPath(stateDir) + ":" + databaseConnectorSocketPath
	replacement := filepath.Join(stateDir, DatabaseTunnelSocketDirectory) + ":" + databaseConnectorSocketDirectory + ":ro"
	updated := append([]string(nil), binds...)
	changed := false
	for index, bind := range updated {
		if bind == legacyBind || bind == legacyBind+":ro" {
			updated[index] = replacement
			changed = true
		}
	}
	return updated, changed
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
	// Keep the engine protocol opaque. PostgreSQL performs its own SSLRequest
	// negotiation on this connection; eagerly upgrading here would consume that
	// handshake and make the workload send a second SSLRequest inside TLS.
	return connection, nil
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
