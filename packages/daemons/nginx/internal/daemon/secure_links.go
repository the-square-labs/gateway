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
	"github.com/wiolett-industries/gateway/daemon-shared/listenerkeep"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	proxySecureLinkOwnerKind    = "proxy_host_secure_link"
	proxySecureLinkSetupTimeout = 2 * time.Second
	proxySecureLinkSocketDir    = "/run/gateway-secure-links"
	registrySecureLinkOwnerKind = "registry_ingress"
	registrySecureLinkSocketDir = "/run/gateway-registry-links"
)

// availabilityMemberSetupBudget bounds the tunnel setup of a member's link
// across all its relays: the cost of a member whose host became unreachable
// before the relays noticed (N-12).
var availabilityMemberSetupBudget = proxySecureLinkSetupTimeout

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
	// suspended is set once this process handed its kept listeners over to
	// the next one (a restart or update): no socket is created or re-created
	// at a path any more, the successor adopts the kept ones.
	suspended atomic.Bool
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

	// Availability data-plane lease (D8, A8): a lease-gated binding's Unix
	// socket listens only while a relay gate view says availabilityCandidateID
	// holds the lease for availabilityPolicyID. leaseMu guards toggling unix
	// independently of the accept-loop bookkeeping above.
	leaseMu                 sync.Mutex
	leaseGated              bool
	leaseOpen               bool
	availabilityPolicyID    string
	availabilityCandidateID string
	dormant                 bool

	// keptName is the listener keeper's name of the Unix listener (empty when
	// it is not kept), and adoptedAt when this process took it over from the
	// previous one. Both are guarded by leaseMu.
	keptName  string
	adoptedAt time.Time
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
		applyLeaseMetadata(created, binding)
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
	var leaseErr error
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
			if err := m.refreshLeaseMetadata(id, current, binding); err != nil && leaseErr == nil {
				leaseErr = fmt.Errorf("reopen proxy secure-link socket %s: %w", id, err)
			}
			continue
		}
		m.bindings[id] = staged[id]
		m.start(id, staged[id])
	}
	if leaseErr != nil {
		// The bindings are applied; the next sync reopens the socket.
		return nil, leaseErr
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
	unixListener, keptName, err := m.listenUnixSocket(socketPath)
	if err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, err
	}
	binding := &sourceLinkBinding{generation: generation, listener: listener, unix: unixListener, socketPath: socketPath, done: make(chan struct{}), active: map[net.Conn]bool{}, socketOnly: socketOnly, keptName: keptName}
	if keptName != "" {
		binding.adoptedAt = time.Now()
	}
	return binding, nil
}

// listenUnixSocket returns the authenticated Unix listener at socketPath,
// owned by the managed nginx worker, and its keeper name when it was taken
// over from the previous daemon process. It is shared by binding creation and
// by reopening a lease-gated binding's socket once its candidate holds the
// lease (D8, A8).
//
// A listener the previous process kept is adopted while the path still names
// that very socket: connections made during the restart waited in its backlog
// and are served now, none was refused. Otherwise a new socket is created (see
// createUnixSocket).
func (m *sourceLinkManager) listenUnixSocket(socketPath string) (net.Listener, string, error) {
	if m.suspended.Load() {
		return nil, "", errors.New("secure-link sockets are being handed over to the next daemon process")
	}
	if listener, name := m.adoptKeptUnixSocket(socketPath); listener != nil {
		return listener, name, nil
	}
	listener, err := m.createUnixSocket(socketPath)
	return listener, "", err
}

// temporarySocketSequence names the temporary sockets createUnixSocket binds.
var temporarySocketSequence atomic.Uint64

// createUnixSocket binds a new socket under a temporary name in the socket
// directory, gives it its final owner and mode, and renames it over
// socketPath (M-2). nginx therefore never sees the path missing while a
// socket is re-created, nor a socket it may not connect to yet (connect()
// failing with EACCES before the owner was set); a stale socket file at the
// path, refusing connections, is replaced in one step.
func (m *sourceLinkManager) createUnixSocket(socketPath string) (net.Listener, error) {
	if err := os.MkdirAll(m.socketDir, 0o755); err != nil {
		return nil, fmt.Errorf("create proxy secure-link socket directory: %w", err)
	}
	if info, err := os.Lstat(socketPath); err == nil && info.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("refuse to replace non-socket secure-link path %s", socketPath)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ownerUID, err := m.socketOwnerUID()
	if err != nil {
		return nil, fmt.Errorf("resolve managed nginx worker uid: %w", err)
	}
	temporary := filepath.Join(filepath.Dir(socketPath), fmt.Sprintf(".%d.%d.tmp", os.Getpid(), temporarySocketSequence.Add(1)))
	_ = os.Remove(temporary)
	listener, err := net.Listen("unix", temporary)
	if err != nil {
		return nil, fmt.Errorf("listen on proxy secure-link socket %s: %w", socketPath, err)
	}
	// The listener's own path is the temporary one: closing it must never
	// unlink anything, the binding removes its path itself.
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	fail := func(err error) (net.Listener, error) {
		_ = listener.Close()
		_ = os.Remove(temporary)
		return nil, err
	}
	if err := os.Chown(temporary, ownerUID, -1); err != nil {
		return fail(fmt.Errorf("set proxy secure-link socket owner: %w", err))
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return fail(err)
	}
	if err := os.Rename(temporary, socketPath); err != nil {
		return fail(fmt.Errorf("publish proxy secure-link socket %s: %w", socketPath, err))
	}
	return listener, nil
}

var temporarySocketName = regexp.MustCompile(`^\.([0-9]+)\.[0-9]+\.tmp$`)

// removeStaleTemporarySockets removes the temporary sockets a daemon process
// that stopped between binding and publishing one left in directory.
func removeStaleTemporarySockets(directory string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	own := fmt.Sprint(os.Getpid())
	for _, entry := range entries {
		match := temporarySocketName.FindStringSubmatch(entry.Name())
		if match == nil || match[1] == own || entry.Type()&os.ModeSocket == 0 {
			continue
		}
		_ = os.Remove(filepath.Join(directory, entry.Name()))
	}
}

// adoptKeptUnixSocket takes over the listener the previous daemon process
// kept for socketPath, if the path still names it.
func (m *sourceLinkManager) adoptKeptUnixSocket(socketPath string) (net.Listener, string) {
	name, err := listenerkeep.Name(socketPath)
	if err != nil {
		return nil, ""
	}
	file, ok := listenerkeep.Take(name)
	if !ok {
		return nil, ""
	}
	defer file.Close()
	listener, err := net.FileListener(file)
	if err != nil {
		_ = listenerkeep.Drop(name)
		return nil, ""
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		_ = listener.Close()
		_ = listenerkeep.Drop(name)
		return nil, ""
	}
	unixListener.SetUnlinkOnClose(false)
	if ownerUID, err := m.socketOwnerUID(); err == nil {
		// The nginx worker user may have changed while no daemon ran.
		_ = os.Chown(socketPath, ownerUID, -1)
	}
	return listener, name
}

// keepUnixListener hands a copy of a Unix listener to the listener keeper so
// that it outlives this process, and returns its keeper name ("" when there is
// no keeper or it could not be kept).
func keepUnixListener(listener net.Listener, socketPath string) string {
	unixListener, ok := listener.(*net.UnixListener)
	if !ok || !listenerkeep.Available() {
		return ""
	}
	name, err := listenerkeep.Name(socketPath)
	if err != nil {
		return ""
	}
	file, err := unixListener.File()
	if err != nil {
		return ""
	}
	defer file.Close()
	if err := listenerkeep.Keep(name, file); err != nil {
		return ""
	}
	return name
}

func (m *sourceLinkManager) start(id string, binding *sourceLinkBinding) {
	if binding.listener != nil {
		m.accept(id, binding, binding.listener, false)
	}
	// A lease-gated binding starts with its Unix socket closed (D8, A8): it is
	// opened later, once a relay gate view says its candidate holds the lease.
	binding.leaseMu.Lock()
	defer binding.leaseMu.Unlock()
	if binding.unix != nil {
		m.accept(id, binding, binding.unix, true)
		if binding.keptName == "" {
			binding.keptName = keepUnixListener(binding.unix, binding.socketPath)
		}
	}
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
			connection = newTrackedConn(connection)
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
		b.leaseMu.Lock()
		if b.keptName != "" {
			_ = listenerkeep.Drop(b.keptName)
			b.keptName = ""
		}
		if b.unix != nil {
			_ = b.unix.Close()
		}
		b.leaseMu.Unlock()
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
	if p.availabilityLease != nil {
		// New or resynced availability members already have a lease-gated
		// binding at this point; open ones whose candidate already holds the
		// lease without waiting for the next periodic sweep (D8, A8).
		p.availabilityLease.reconcileSockets()
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
	if p.availabilityLease != nil {
		go p.availabilityLease.runForTarget(ctx, conn, relayInstanceID)
	}
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

var (
	// secureLinkTransientWait is how long a new connection waits for a relay lane or its target's registration to
	// come back before it fails. A relay restart (the local relay's update on a single-relay installation) or a
	// docker-daemon restart leaves every candidate without a ready lane, or without the target's registration, for
	// well under a second to a couple of seconds: waiting turns those 502s into a short delay. Links of availability
	// members never wait; the upstream moves on to the next member at once.
	secureLinkTransientWait  = 3 * time.Second
	secureLinkTransientRetry = 150 * time.Millisecond
)

type secureLinkOpenResult int

const (
	secureLinkOpened secureLinkOpenResult = iota
	// The lane's transport is not ready or the target is not registered yet: worth another try shortly.
	secureLinkRetryable
	secureLinkFailed
)

// retryableRelayOpenError reports a relay that is restarting (lane transport not ready, stream broken) or a target
// that has not registered yet (its daemon is restarting). A closed lease gate, a dormant availability member, a
// session limit or a grant the relay rejects are final.
func retryableRelayOpenError(err error) bool {
	current, ok := status.FromError(err)
	if !ok || current.Code() != codes.Unavailable {
		return false
	}
	message := current.Message()
	return !strings.Contains(message, "dormant") && !strings.Contains(message, "built-in local service")
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
	// A member's link fails at once when a relay refused it, so its upstream
	// moves on to the next member. While this daemon has no lane to any of
	// its relays (just started, or every relay restarting) every member fails
	// alike, so it waits for a lane like any other link (B-13).
	member := ownerKind == proxySecureLinkOwnerKind && p.secureLinks.availabilityMember(linkID)
	deadline := time.Now().Add(secureLinkTransientWait)
	// A member's tunnel setup shares one budget across its relays (N-12):
	// when the member's host is unreachable every relay still holds its
	// registration until it notices, and each would take the whole setup
	// timeout (three relays: 6 s). nginx retries the next member instead.
	var memberSetupDeadline time.Time
	for {
		retryable := false
		reachedRelay := false
		ordered := p.orderRelayCandidates(candidates)
		for index, candidate := range ordered {
			tunnel := p.selectRelayTunnel(candidate.GetRelayInstanceId())
			if tunnel == nil {
				// No lane to this relay yet: a lane that comes up counts.
				retryable = true
				continue
			}
			reachedRelay = true
			grant := relaybridge.GrantForCandidate(candidate)
			if grant == nil {
				tunnel.active.Add(-1)
				continue
			}
			setup := proxySecureLinkSetupTimeout
			if member {
				if memberSetupDeadline.IsZero() {
					memberSetupDeadline = time.Now().Add(availabilityMemberSetupBudget)
				}
				if setup = time.Until(memberSetupDeadline); setup <= 0 {
					tunnel.active.Add(-1)
					break
				}
			}
			switch p.openProxySecureLinkOnTunnel(linkID, connection, tunnel, grant, setup) {
			case secureLinkOpened:
				return
			case secureLinkRetryable:
				retryable = true
			}
			if index+1 < len(ordered) {
				time.Sleep(time.Duration(index+1) * 50 * time.Millisecond)
			}
		}
		if !retryable || (member && reachedRelay) || !time.Now().Add(secureLinkTransientRetry).Before(deadline) {
			break
		}
		time.Sleep(secureLinkTransientRetry)
	}
	p.logger.Warn(logName+" connection failed on all relay candidates", "link_id", linkID)
}

// availabilityMember reports a binding of an availability policy member.
func (m *sourceLinkManager) availabilityMember(id string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	binding := m.bindings[id]
	m.mu.Unlock()
	if binding == nil {
		return false
	}
	binding.leaseMu.Lock()
	defer binding.leaseMu.Unlock()
	return binding.availabilityPolicyID != ""
}

func (p *NginxPlugin) orderRelayCandidates(candidates []*pb.RelayDataCandidate) []*pb.RelayDataCandidate {
	if len(candidates) < 2 {
		return append([]*pb.RelayDataCandidate(nil), candidates...)
	}
	p.relayTunnelMu.Lock()
	transports := make(map[string]relaybridge.TransportLoad, len(p.relayTunnels))
	for _, tunnel := range p.relayTunnels {
		load := transports[tunnel.targetID]
		transports[tunnel.targetID] = relaybridge.TransportLoad{Available: true, Active: load.Active + tunnel.active.Load()}
	}
	rotation := p.relaySelection
	p.relaySelection++
	p.relayTunnelMu.Unlock()
	return relaybridge.OrderCandidates(candidates, transports, rotation, relaybridge.Latency.RTT)
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

func (p *NginxPlugin) openProxySecureLinkOnTunnel(linkID string, connection net.Conn, tunnel *nginxRelayTunnel, grant *pb.RelaySignedGrant, setupTimeout time.Duration) secureLinkOpenResult {
	defer tunnel.active.Add(-1)
	ctx, cancel, finishSetup := proxySecureLinkSetupContext(tunnel.ctx, setupTimeout)
	defer cancel()
	stream, err := tunnel.client.OpenTunnel(ctx)
	if err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "open", "error", err)
		return openFailure(err)
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}}); err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "send", "error", err)
		return openFailure(err)
	}
	first, err := stream.Recv()
	if err != nil {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "ready", "error", err)
		return openFailure(err)
	}
	if first.GetReady() == nil {
		code := "unexpected_frame"
		if relayError := first.GetError(); relayError != nil {
			code = relayError.GetCode()
		}
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "ready", "error", code)
		return secureLinkFailed
	}
	if !finishSetup() {
		p.logger.Warn("proxy secure-link relay attempt failed", "link_id", linkID, "relay_instance_id", tunnel.targetID, "stage", "deadline", "error", "setup timeout")
		return secureLinkFailed
	}
	readChunk := int(p.relayGrants.get().GetReadChunkBytes())
	if readChunk == 0 {
		readChunk = relaybridge.DefaultChunkBytes
	}
	_ = relaybridge.BridgeWithChunk(ctx, connection, stream, int(first.GetReady().MaxFrameBytes), readChunk, cancel)
	return secureLinkOpened
}

func openFailure(err error) secureLinkOpenResult {
	if retryableRelayOpenError(err) {
		return secureLinkRetryable
	}
	return secureLinkFailed
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
