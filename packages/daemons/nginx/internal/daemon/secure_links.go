package daemon

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

const (
	proxySecureLinkOwnerKind    = "proxy_host_secure_link"
	proxySecureLinkSetupTimeout = 2 * time.Second
	proxySecureLinkSocketDir    = "/run/gateway-secure-links"
	registrySecureLinkOwnerKind = "registry_ingress"
	registrySecureLinkSocketDir = "/run/gateway-registry-links"
)

var secureLinkIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type nginxRelayTunnel struct {
	ctx      context.Context
	client   relayv1.TunnelBrokerClient
	targetID string
	active   atomic.Int64
}

type sourceLinkManager struct {
	mu                sync.Mutex
	bindings          map[string]*sourceLinkBinding
	opener            func(string, net.Conn)
	socketDir         string
	authorizeUnixPeer func(net.Conn) bool
	socketOwnerUID    func() (int, error)
	renameSocket      func(string, string) error
}

type sourceLinkBinding struct {
	generation uint64
	listener   net.Listener
	unix       net.Listener
	socketPath string
	done       chan struct{}
	activeMu   sync.Mutex
	active     map[net.Conn]bool
	socketOnly bool
}

type sourceLinkStatus struct {
	LinkID     string `json:"linkId"`
	Generation uint64 `json:"generation"`
	Port       int    `json:"port"`
	SocketPath string `json:"socketPath"`
}

func proxySecureLinkSetupContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc, func() bool) {
	ctx, cancel := context.WithCancel(parent)
	timer := time.AfterFunc(timeout, cancel)
	return ctx, cancel, timer.Stop
}

func newSourceLinkManager(opener func(string, net.Conn), nginxBinary string, masterPID func() (int, error)) *sourceLinkManager {
	return newSourceLinkManagerAt(opener, proxySecureLinkSocketDir, nginxBinary, masterPID)
}

func newSourceLinkManagerAt(
	opener func(string, net.Conn),
	socketDir string,
	nginxBinary string,
	masterPID func() (int, error),
) *sourceLinkManager {
	canonicalNginxBinary := canonicalExecutablePath(nginxBinary)
	socketOwnerUID := func() (int, error) {
		if masterPID == nil {
			return os.Getuid(), nil
		}
		pid, err := masterPID()
		if err != nil {
			return 0, err
		}
		return managedNginxWorkerUID(pid, canonicalNginxBinary)
	}
	return &sourceLinkManager{
		bindings:  map[string]*sourceLinkBinding{},
		opener:    opener,
		socketDir: socketDir,
		authorizeUnixPeer: func(connection net.Conn) bool {
			return isAuthorizedUnixPeer(connection, canonicalNginxBinary, masterPID)
		},
		socketOwnerUID: socketOwnerUID,
		renameSocket:   os.Rename,
	}
}

func canonicalExecutablePath(path string) string {
	if path == "" {
		return ""
	}
	resolvedPath, err := exec.LookPath(path)
	if err != nil {
		return ""
	}
	path = resolvedPath
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

func isAuthorizedUnixPeer(connection net.Conn, nginxBinary string, masterPID func() (int, error)) bool {
	peer, err := unixPeerCredentials(connection)
	if err != nil {
		return false
	}
	if peer.pid == os.Getpid() {
		return true
	}
	if nginxBinary == "" || masterPID == nil {
		return false
	}
	managedPID, err := masterPID()
	if err != nil {
		return false
	}
	return isManagedNginxProcess(peer.pid, managedPID, nginxBinary)
}

func (m *sourceLinkManager) sync(command *pb.SyncProxySecureLinksCommand) ([]sourceLinkStatus, error) {
	if command == nil {
		return nil, errors.New("proxy secure-link bindings are required")
	}
	desired := make(map[string]*pb.ProxySecureLinkBinding, len(command.Bindings))
	for _, binding := range command.Bindings {
		if binding.Role != "source" || !secureLinkIDPattern.MatchString(binding.LinkId) || binding.ListenerPort > 65535 {
			return nil, errors.New("invalid proxy secure-link source binding")
		}
		if _, exists := desired[binding.LinkId]; exists {
			return nil, fmt.Errorf("duplicate proxy secure-link binding %s", binding.LinkId)
		}
		desired[binding.LinkId] = binding
	}
	desiredIDs := make([]string, 0, len(desired))
	for id := range desired {
		desiredIDs = append(desiredIDs, id)
	}
	sort.Strings(desiredIDs)

	m.mu.Lock()
	defer m.mu.Unlock()
	for id, binding := range desired {
		if current := m.bindings[id]; current != nil && binding.Generation < current.generation {
			return nil, fmt.Errorf("stale generation for proxy secure-link %s", id)
		}
	}
	staged := make(map[string]*sourceLinkBinding)
	stagedTCP := make(map[string]net.Listener)
	closeStaged := func() {
		for _, listener := range staged {
			listener.close()
		}
		for _, listener := range stagedTCP {
			_ = listener.Close()
		}
	}
	for _, id := range desiredIDs {
		binding := desired[id]
		current := m.bindings[id]
		if current != nil && !binding.RotateListener {
			if !binding.SocketOnly && current.listener == nil {
				listener, err := listenSourceLinkTCP(id, binding.ListenerPort)
				if err != nil && binding.ListenerPort != 0 {
					listener, err = listenSourceLinkTCP(id, 0)
				}
				if err != nil {
					closeStaged()
					return nil, err
				}
				stagedTCP[id] = listener
			}
			continue
		}
		requestedPort := binding.ListenerPort
		stageSocketOnly := binding.SocketOnly
		preserveTCP := current != nil && binding.RotateListener && !binding.SocketOnly && current.listener != nil
		if binding.RotateListener && binding.SocketOnly {
			requestedPort = 0
		} else if preserveTCP {
			stageSocketOnly = true
			requestedPort = 0
		}
		socketPath := filepath.Join(m.socketDir, id+".sock")
		if current != nil && binding.RotateListener {
			socketPath += ".next"
		}
		created, err := m.createAtPath(id, binding.Generation, requestedPort, stageSocketOnly, socketPath)
		allowPortFallback := !(current != nil && binding.RotateListener && !binding.SocketOnly)
		if err != nil && requestedPort != 0 && allowPortFallback {
			created, err = m.createAtPath(id, binding.Generation, 0, stageSocketOnly, socketPath)
		}
		if err != nil {
			closeStaged()
			return nil, err
		}
		if preserveTCP {
			listener, duplicateErr := duplicateTCPListener(current.listener)
			if duplicateErr != nil {
				created.close()
				closeStaged()
				return nil, fmt.Errorf("preserve proxy secure-link TCP listener %s: %w", id, duplicateErr)
			}
			created.listener = listener
			created.socketOnly = false
		}
		staged[id] = created
	}
	type publishedRotation struct {
		id          string
		canonical   string
		staging     string
		backup      string
		hadPrevious bool
	}
	published := make([]publishedRotation, 0)
	rotationBackups := make(map[string]string)
	rollbackPublished := func() error {
		for index := len(published) - 1; index >= 0; index-- {
			rotation := published[index]
			moveErr := m.renameSocket(rotation.canonical, rotation.staging)
			if moveErr == nil {
				staged[rotation.id].socketPath = rotation.staging
			}
			if rotation.hadPrevious {
				if restoreErr := m.renameSocket(rotation.backup, rotation.canonical); restoreErr != nil {
					if moveErr == nil {
						if republishErr := m.renameSocket(rotation.staging, rotation.canonical); republishErr == nil {
							staged[rotation.id].socketPath = rotation.canonical
						}
					}
					return errors.Join(moveErr, fmt.Errorf("restore previous proxy secure-link socket %s: %w", rotation.id, restoreErr))
				}
				if moveErr != nil {
					// Restoring the backup atomically replaced the published socket.
					// Its listener is now unlinked, so cleanup must target only the
					// original staging pathname, never the restored canonical path.
					staged[rotation.id].socketPath = rotation.staging
				}
			} else if moveErr != nil {
				return fmt.Errorf("rollback proxy secure-link socket %s: %w", rotation.id, moveErr)
			}
		}
		return nil
	}
	for _, id := range desiredIDs {
		binding := desired[id]
		current := m.bindings[id]
		if current == nil || !binding.RotateListener {
			continue
		}
		canonical := current.socketPath
		staging := staged[id].socketPath
		backup := canonical + ".previous"
		if err := removeExistingSocket(backup); err != nil {
			if rollbackErr := rollbackPublished(); rollbackErr != nil {
				return nil, errors.Join(err, rollbackErr)
			}
			closeStaged()
			return nil, err
		}
		hadPrevious := true
		if err := m.renameSocket(canonical, backup); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				if rollbackErr := rollbackPublished(); rollbackErr != nil {
					return nil, errors.Join(err, rollbackErr)
				}
				closeStaged()
				return nil, fmt.Errorf("stage previous proxy secure-link socket %s: %w", id, err)
			}
			hadPrevious = false
		}
		if err := m.renameSocket(staging, canonical); err != nil {
			var restoreErr error
			if hadPrevious {
				restoreErr = m.renameSocket(backup, canonical)
			}
			rollbackErr := rollbackPublished()
			if restoreErr != nil || rollbackErr != nil {
				return nil, errors.Join(err, restoreErr, rollbackErr)
			}
			closeStaged()
			return nil, fmt.Errorf("publish proxy secure-link socket %s: %w", id, err)
		}
		staged[id].socketPath = canonical
		if hadPrevious {
			rotationBackups[id] = backup
		}
		published = append(published, publishedRotation{
			id: id, canonical: canonical, staging: staging, backup: backup, hadPrevious: hadPrevious,
		})
	}
	for id, binding := range desired {
		current := m.bindings[id]
		if current == nil || binding.RotateListener {
			continue
		}
		if binding.SocketOnly && current.listener != nil {
			current.disableTCP()
		} else if listener := stagedTCP[id]; listener != nil {
			current.activeMu.Lock()
			current.socketOnly = false
			current.activeMu.Unlock()
			current.listener = listener
			m.accept(id, current, listener, false)
			delete(stagedTCP, id)
		}
		if binding.SocketOnly {
			current.activeMu.Lock()
			current.socketOnly = true
			current.activeMu.Unlock()
		}
	}
	for id, current := range m.bindings {
		if _, keep := desired[id]; keep {
			continue
		}
		current.close()
		delete(m.bindings, id)
	}
	for id, binding := range desired {
		current := m.bindings[id]
		if current != nil && binding.RotateListener {
			// The staged listener now owns the canonical path. Closing the retired
			// binding must not unlink it; the old path was retained as a rollback
			// backup until every rotation was published.
			current.closePreservingSocketPath()
			if backup := rotationBackups[id]; backup != "" {
				_ = os.Remove(backup)
			}
			m.bindings[id] = staged[id]
			m.start(id, staged[id])
			continue
		}
		if current != nil {
			// Listener ports are daemon-owned. Once a listener exists, retain it
			// even if the control plane still has the pre-restart port; the
			// returned status will reconcile that stale value without churn.
			current.generation = binding.Generation
			continue
		}
		m.bindings[id] = staged[id]
		m.start(id, staged[id])
	}
	statuses := make([]sourceLinkStatus, 0, len(m.bindings))
	for id, binding := range m.bindings {
		port := 0
		if binding.listener != nil {
			port = binding.listener.Addr().(*net.TCPAddr).Port
		}
		statuses = append(statuses, sourceLinkStatus{LinkID: id, Generation: binding.generation, Port: port, SocketPath: binding.socketPath})
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].LinkID < statuses[j].LinkID })
	return statuses, nil
}

func listenSourceLinkTCP(id string, port uint32) (net.Listener, error) {
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, fmt.Errorf("listen for proxy secure-link %s: %w", id, err)
	}
	return listener, nil
}

func duplicateTCPListener(listener net.Listener) (net.Listener, error) {
	tcpListener, ok := listener.(*net.TCPListener)
	if !ok {
		return nil, errors.New("source listener is not TCP")
	}
	file, err := tcpListener.File()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return net.FileListener(file)
}

func (m *sourceLinkManager) create(id string, generation uint64, port uint32, socketOnly bool) (*sourceLinkBinding, error) {
	return m.createAtPath(id, generation, port, socketOnly, filepath.Join(m.socketDir, id+".sock"))
}

func removeExistingSocket(socketPath string) error {
	if info, statErr := os.Lstat(socketPath); statErr == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("refuse to replace non-socket secure-link path %s", socketPath)
		}
		return os.Remove(socketPath)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	return nil
}

func (m *sourceLinkManager) createAtPath(
	id string,
	generation uint64,
	port uint32,
	socketOnly bool,
	socketPath string,
) (*sourceLinkBinding, error) {
	var listener net.Listener
	var err error
	if !socketOnly {
		listener, err = listenSourceLinkTCP(id, port)
		if err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(m.socketDir, 0o755); err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, fmt.Errorf("create proxy secure-link socket directory: %w", err)
	}
	if err := removeExistingSocket(socketPath); err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, err
	}
	unixListener, err := net.Listen("unix", socketPath)
	if err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, fmt.Errorf("listen on proxy secure-link socket %s: %w", id, err)
	}
	ownerUID, err := m.socketOwnerUID()
	if err != nil {
		_ = unixListener.Close()
		if listener != nil {
			_ = listener.Close()
		}
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("resolve managed nginx worker uid: %w", err)
	}
	if err := os.Chown(socketPath, ownerUID, -1); err != nil {
		_ = unixListener.Close()
		if listener != nil {
			_ = listener.Close()
		}
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("set proxy secure-link socket owner: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = unixListener.Close()
		if listener != nil {
			_ = listener.Close()
		}
		_ = os.Remove(socketPath)
		return nil, err
	}
	binding := &sourceLinkBinding{generation: generation, listener: listener, unix: unixListener, socketPath: socketPath, done: make(chan struct{}), active: map[net.Conn]bool{}, socketOnly: socketOnly}
	return binding, nil
}

func (m *sourceLinkManager) start(id string, binding *sourceLinkBinding) {
	if binding.listener != nil {
		m.accept(id, binding, binding.listener, false)
	}
	m.accept(id, binding, binding.unix, true)
}

func (m *sourceLinkManager) accept(id string, binding *sourceLinkBinding, listener net.Listener, authorizePeer bool) {
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			if authorizePeer && (m.authorizeUnixPeer == nil || !m.authorizeUnixPeer(connection)) {
				_ = connection.Close()
				continue
			}
			binding.activeMu.Lock()
			if !authorizePeer && binding.socketOnly {
				binding.activeMu.Unlock()
				_ = connection.Close()
				continue
			}
			binding.active[connection] = authorizePeer
			binding.activeMu.Unlock()
			go func() {
				defer func() {
					binding.activeMu.Lock()
					delete(binding.active, connection)
					binding.activeMu.Unlock()
				}()
				m.opener(id, connection)
			}()
		}
	}()
}

func (b *sourceLinkBinding) close() {
	b.closeBinding(true)
}

func (b *sourceLinkBinding) closePreservingSocketPath() {
	if unixListener, ok := b.unix.(*net.UnixListener); ok {
		unixListener.SetUnlinkOnClose(false)
	}
	b.closeBinding(false)
}

func (b *sourceLinkBinding) closeBinding(removeSocketPath bool) {
	select {
	case <-b.done:
		return
	default:
		close(b.done)
		if b.listener != nil {
			_ = b.listener.Close()
		}
		_ = b.unix.Close()
		if removeSocketPath {
			_ = os.Remove(b.socketPath)
		}
		b.closeActive()
	}
}

func (b *sourceLinkBinding) closeActive() {
	b.activeMu.Lock()
	defer b.activeMu.Unlock()
	for connection := range b.active {
		_ = connection.Close()
	}
}

func (b *sourceLinkBinding) disableTCP() {
	if b.listener != nil {
		_ = b.listener.Close()
		b.listener = nil
	}
	b.activeMu.Lock()
	defer b.activeMu.Unlock()
	b.socketOnly = true
	for connection, isUnix := range b.active {
		if !isUnix {
			_ = connection.Close()
		}
	}
}

func (m *sourceLinkManager) closeActive(linkID string) {
	m.mu.Lock()
	binding := m.bindings[linkID]
	m.mu.Unlock()
	if binding != nil {
		binding.closeActive()
	}
}

func (m *sourceLinkManager) port(linkID string) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding := m.bindings[linkID]
	if binding == nil || binding.listener == nil {
		return 0, false
	}
	return binding.listener.Addr().(*net.TCPAddr).Port, true
}

func (m *sourceLinkManager) socket(linkID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding := m.bindings[linkID]
	if binding == nil || binding.socketPath == "" {
		return "", false
	}
	return binding.socketPath, true
}

func (p *NginxPlugin) SyncRelayGrants(command *pb.SyncRelayGrantsCommand) (string, error) {
	if p.relayGrants == nil {
		return "", errors.New("relay grant store is unavailable")
	}
	previous := p.relayGrants.get()
	if err := p.relayGrants.sync(command); err != nil {
		return "", err
	}
	if p.secureLinks != nil {
		for _, assignment := range previous.Grants {
			if assignment.Role == "connect" && assignment.OwnerKind == proxySecureLinkOwnerKind &&
				findRelayAssignment(command, "connect", proxySecureLinkOwnerKind, assignment.OwnerId) == nil {
				p.secureLinks.closeActive(assignment.OwnerId)
			}
		}
	}
	return "", nil
}

func (p *NginxPlugin) RelayTunnelLaneCount() int {
	lanes := int(p.relayGrants.get().GetDataLanes())
	if lanes < 1 {
		return 4
	}
	return lanes
}

func (p *NginxPlugin) RelayTunnelRuntimeChanged() <-chan struct{} {
	return p.relayGrants.changed
}

func (p *NginxPlugin) RelayTunnelTargets() []lifecycle.RelayTunnelTarget {
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

func (p *NginxPlugin) SyncProxySecureLinks(command *pb.SyncProxySecureLinksCommand) (string, error) {
	if p.secureLinks == nil {
		return "", errors.New("proxy secure-link manager is unavailable")
	}
	statuses, err := p.secureLinks.sync(command)
	if err != nil {
		return "", err
	}
	if err := p.secureLinkState.Save(normalizeSourceBindings(command, statuses)); err != nil {
		// Never acknowledge an uncommitted listener set. Refuse new streams
		// until the control plane retries from its durable desired state.
		_, _ = p.secureLinks.sync(&pb.SyncProxySecureLinksCommand{})
		return "", err
	}
	detail, err := json.Marshal(map[string]any{"bindings": statuses})
	return string(detail), err
}

func normalizeSourceBindings(command *pb.SyncProxySecureLinksCommand, statuses []sourceLinkStatus) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	ports := make(map[string]uint32, len(statuses))
	for _, status := range statuses {
		ports[status.LinkID] = uint32(status.Port)
	}
	for _, binding := range normalized.Bindings {
		binding.ListenerPort = ports[binding.LinkId]
		binding.RotateListener = false
	}
	return normalized
}

func (p *NginxPlugin) ProbeProxySecureLink(command *pb.ProbeProxySecureLinkCommand) (string, error) {
	if command == nil || !secureLinkIDPattern.MatchString(command.LinkId) {
		return "", errors.New("invalid proxy secure-link probe")
	}
	if command.Scheme != "http" && command.Scheme != "https" {
		return "", errors.New("unsupported proxy secure-link probe scheme")
	}
	if !strings.HasPrefix(command.Path, "/") {
		return "", errors.New("proxy secure-link probe path must start with /")
	}
	socketPath, ok := p.secureLinks.socket(command.LinkId)
	if !ok {
		return "", errors.New("proxy secure-link listener is unavailable")
	}
	timeout := time.Duration(command.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > 30*time.Second {
		timeout = 10 * time.Second
	}
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", socketPath)
		},
		// This checks upstream behavior through the authenticated relay path;
		// certificate policy remains the responsibility of the proxy config.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: timeout}
	started := time.Now()
	response, err := client.Get(command.Scheme + "://secure-link.internal" + command.Path)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil {
		return "", err
	}
	if len(body) > 1024*1024 {
		return "", errors.New("proxy secure-link probe response is too large")
	}
	passed := response.StatusCode >= 200 && response.StatusCode < 300
	if command.ExpectedStatus != 0 {
		passed = response.StatusCode == int(command.ExpectedStatus)
	}
	if passed && command.ExpectedBody != "" {
		actual := string(body)
		switch command.BodyMatchMode {
		case "exact":
			passed = actual == command.ExpectedBody
		case "starts_with":
			passed = strings.HasPrefix(actual, command.ExpectedBody)
		case "ends_with":
			passed = strings.HasSuffix(actual, command.ExpectedBody)
		default:
			passed = strings.Contains(actual, command.ExpectedBody)
		}
	}
	detail, err := json.Marshal(map[string]any{
		"ok": passed, "httpStatus": response.StatusCode, "responseMs": time.Since(started).Milliseconds(),
	})
	return string(detail), err
}

func (p *NginxPlugin) RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, _ string) {
	p.RunRelayTargetTunnels(ctx, conn, "", relaybridge.LegacyTargetID)
}

func (p *NginxPlugin) RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, _ string, relayInstanceID string) {
	tunnel := &nginxRelayTunnel{ctx: ctx, client: relayv1.NewTunnelBrokerClient(conn), targetID: relayInstanceID}
	p.relayTunnelMu.Lock()
	p.relayTunnels = append(p.relayTunnels, tunnel)
	p.relayTunnelMu.Unlock()
	p.logger.Debug("proxy secure-link relay lane ready")
	<-ctx.Done()
	p.relayTunnelMu.Lock()
	for index, candidate := range p.relayTunnels {
		if candidate == tunnel {
			p.relayTunnels = append(p.relayTunnels[:index], p.relayTunnels[index+1:]...)
			break
		}
	}
	p.relayTunnelMu.Unlock()
}

func (p *NginxPlugin) openProxySecureLink(linkID string, connection net.Conn) {
	p.openSecureLink(proxySecureLinkOwnerKind, "proxy secure-link", linkID, connection)
}

func (p *NginxPlugin) openRegistrySecureLink(linkID string, connection net.Conn) {
	p.openSecureLink(registrySecureLinkOwnerKind, "registry ingress", linkID, connection)
}

func (p *NginxPlugin) openSecureLink(ownerKind, logName, linkID string, connection net.Conn) {
	defer connection.Close()
	assignment := findRelayAssignment(p.relayGrants.get(), "connect", ownerKind, linkID)
	if assignment == nil {
		p.logger.Warn(logName+" connection rejected", "link_id", linkID, "stage", "grant")
		return
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	candidates = p.orderRelayCandidates(candidates)
	for index, candidate := range candidates {
		tunnel := p.selectRelayTunnel(candidate.GetRelayInstanceId())
		if tunnel == nil {
			continue
		}
		grant := relaybridge.GrantForCandidate(candidate)
		if grant == nil {
			continue
		}
		if p.openProxySecureLinkOnTunnel(linkID, connection, tunnel, grant) {
			return
		}
		if index+1 < len(candidates) {
			time.Sleep(time.Duration(index+1) * 50 * time.Millisecond)
		}
	}
	p.logger.Warn(logName+" connection failed on all relay candidates", "link_id", linkID)
}

func (p *NginxPlugin) orderRelayCandidates(candidates []*pb.RelayDataCandidate) []*pb.RelayDataCandidate {
	ordered := append([]*pb.RelayDataCandidate(nil), candidates...)
	if len(ordered) < 2 {
		return ordered
	}
	p.relayTunnelMu.Lock()
	loads := make(map[string]int64, len(ordered))
	available := make(map[string]bool, len(ordered))
	for _, tunnel := range p.relayTunnels {
		available[tunnel.targetID] = true
		loads[tunnel.targetID] += tunnel.active.Load()
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

func (p *NginxPlugin) selectRelayTunnel(targetID string) *nginxRelayTunnel {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	var selected *nginxRelayTunnel
	for _, tunnel := range p.relayTunnels {
		if tunnel.targetID != targetID {
			continue
		}
		if selected == nil || tunnel.active.Load() < selected.active.Load() {
			selected = tunnel
		}
	}
	if selected != nil {
		selected.active.Add(1)
	}
	return selected
}

func (p *NginxPlugin) openProxySecureLinkOnTunnel(linkID string, connection net.Conn, tunnel *nginxRelayTunnel, grant *pb.RelaySignedGrant) bool {
	defer tunnel.active.Add(-1)
	ctx, cancel, finishSetup := proxySecureLinkSetupContext(tunnel.ctx, proxySecureLinkSetupTimeout)
	defer cancel()
	stream, err := tunnel.client.OpenTunnel(ctx)
	if err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "open", "error", err)
		return false
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}}); err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "send", "error", err)
		return false
	}
	first, err := stream.Recv()
	if err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "ready", "error", err)
		return false
	}
	if first.GetReady() == nil {
		code := "unexpected_frame"
		if relayError := first.GetError(); relayError != nil {
			code = relayError.GetCode()
		}
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "ready", "error", code)
		return false
	}
	if !finishSetup() {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "deadline", "error", "setup timeout")
		return false
	}
	readChunk := int(p.relayGrants.get().GetReadChunkBytes())
	if readChunk == 0 {
		readChunk = relaybridge.DefaultChunkBytes
	}
	_ = relaybridge.BridgeWithChunk(ctx, connection, stream, int(first.GetReady().MaxFrameBytes), readChunk, cancel)
	return true
}

func (p *NginxPlugin) ProbeRelayCandidate(command *pb.ProbeRelayCandidateCommand) (string, error) {
	if command == nil || command.GetRole() != "source" || command.GetCandidate() == nil ||
		command.GetAssignmentGeneration() != command.GetCandidate().GetAssignmentGeneration() {
		return "", errors.New("invalid relay source probe")
	}
	grant := relaybridge.GrantForCandidate(command.GetCandidate())
	if grant == nil {
		return "", errors.New("relay candidate probe grant is missing")
	}
	deadline := time.Now().Add(10 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		tunnel := p.selectRelayTunnel(command.GetCandidate().GetRelayInstanceId())
		if tunnel == nil {
			lastErr = errors.New("relay candidate lane is unavailable")
			time.Sleep(100 * time.Millisecond)
			continue
		}
		ctx, cancel := context.WithTimeout(tunnel.ctx, 2*time.Second)
		stream, err := tunnel.client.OpenTunnel(ctx)
		if err == nil {
			err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}})
		}
		if err == nil {
			var first *relayv1.TunnelFrame
			first, err = stream.Recv()
			if err == nil && first.GetReady() == nil {
				err = errors.New("relay candidate did not acknowledge tunnel")
			}
		}
		cancel()
		tunnel.active.Add(-1)
		if err == nil {
			lastErr = nil
			break
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil {
		return "", lastErr
	}
	detail, err := json.Marshal(map[string]any{"probeId": command.GetProbeId(), "ready": true})
	return string(detail), err
}

func relayGrant(grant *pb.RelaySignedGrant) *relayv1.SignedGrant {
	if grant == nil {
		return nil
	}
	return &relayv1.SignedGrant{KeyId: grant.KeyId, Payload: grant.Payload, Signature: grant.Signature}
}
