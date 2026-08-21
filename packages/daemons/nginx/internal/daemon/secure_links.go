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
)

var secureLinkIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type nginxRelayTunnel struct {
	ctx      context.Context
	client   relayv1.TunnelBrokerClient
	targetID string
	active   atomic.Int64
}

type sourceLinkManager struct {
	mu        sync.Mutex
	bindings  map[string]*sourceLinkBinding
	opener    func(string, net.Conn)
	socketDir string
}

type sourceLinkBinding struct {
	generation uint64
	listener   net.Listener
	unix       net.Listener
	socketPath string
	done       chan struct{}
	activeMu   sync.Mutex
	active     map[net.Conn]struct{}
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

func newSourceLinkManager(opener func(string, net.Conn)) *sourceLinkManager {
	return &sourceLinkManager{bindings: map[string]*sourceLinkBinding{}, opener: opener, socketDir: proxySecureLinkSocketDir}
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

	m.mu.Lock()
	defer m.mu.Unlock()
	for id, binding := range desired {
		if current := m.bindings[id]; current != nil && binding.Generation < current.generation {
			return nil, fmt.Errorf("stale generation for proxy secure-link %s", id)
		}
	}
	staged := make(map[string]*sourceLinkBinding)
	for id, binding := range desired {
		if m.bindings[id] != nil && !binding.RotateListener {
			continue
		}
		requestedPort := binding.ListenerPort
		if binding.RotateListener {
			requestedPort = 0
		}
		created, err := m.create(id, binding.Generation, requestedPort)
		if err != nil && requestedPort != 0 {
			created, err = m.create(id, binding.Generation, 0)
		}
		if err != nil {
			for _, listener := range staged {
				listener.close()
			}
			return nil, err
		}
		staged[id] = created
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
			// create() has already replaced the filesystem entry with the
			// staged Unix listener. Closing the retired binding must not unlink
			// that replacement path.
			current.closePreservingSocketPath()
			m.bindings[id] = staged[id]
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
	}
	statuses := make([]sourceLinkStatus, 0, len(m.bindings))
	for id, binding := range m.bindings {
		statuses = append(statuses, sourceLinkStatus{LinkID: id, Generation: binding.generation, Port: binding.listener.Addr().(*net.TCPAddr).Port, SocketPath: binding.socketPath})
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].LinkID < statuses[j].LinkID })
	return statuses, nil
}

func (m *sourceLinkManager) create(id string, generation uint64, port uint32) (*sourceLinkBinding, error) {
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, fmt.Errorf("listen for proxy secure-link %s: %w", id, err)
	}
	if err := os.MkdirAll(m.socketDir, 0o755); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("create proxy secure-link socket directory: %w", err)
	}
	socketPath := filepath.Join(m.socketDir, id+".sock")
	if info, statErr := os.Lstat(socketPath); statErr == nil {
		if info.Mode()&os.ModeSocket == 0 {
			_ = listener.Close()
			return nil, fmt.Errorf("refuse to replace non-socket secure-link path %s", socketPath)
		}
		if err := os.Remove(socketPath); err != nil {
			_ = listener.Close()
			return nil, err
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		_ = listener.Close()
		return nil, statErr
	}
	unixListener, err := net.Listen("unix", socketPath)
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("listen on proxy secure-link socket %s: %w", id, err)
	}
	if err := os.Chmod(socketPath, 0o666); err != nil {
		_ = unixListener.Close()
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, err
	}
	binding := &sourceLinkBinding{generation: generation, listener: listener, unix: unixListener, socketPath: socketPath, done: make(chan struct{}), active: map[net.Conn]struct{}{}}
	accept := func(current net.Listener) {
		for {
			connection, err := current.Accept()
			if err != nil {
				return
			}
			binding.activeMu.Lock()
			binding.active[connection] = struct{}{}
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
	}
	go accept(listener)
	go accept(unixListener)
	return binding, nil
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
		_ = b.listener.Close()
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
	if binding == nil {
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
	defer connection.Close()
	assignment := findRelayAssignment(p.relayGrants.get(), "connect", proxySecureLinkOwnerKind, linkID)
	if assignment == nil {
		p.logger.Warn("proxy secure-link connection rejected", "link_id", linkID, "stage", "grant")
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
	p.logger.Warn("proxy secure-link connection failed on all relay candidates", "link_id", linkID)
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
