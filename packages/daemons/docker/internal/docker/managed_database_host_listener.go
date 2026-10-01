package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
)

const (
	// managedDatabaseHostListenerGlobalConnections bounds the connections of every binding's host listener on the
	// node together (file descriptors).
	managedDatabaseHostListenerGlobalConnections = 1024
	managedDatabaseHostListenerInspectTimeout    = 5 * time.Second
)

// errManagedDatabaseListenerUnverified marks a listener network that could not be inspected (a slow or failing
// Docker API). That proves nothing about the network, so a running listener keeps serving its connections.
var errManagedDatabaseListenerUnverified = errors.New("inspect managed database listener network")

var managedDatabaseHostContainerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type managedDatabaseHostListenerConfig struct {
	bindingID       string
	networkName     string
	networkID       string
	listenAddress   netip.Addr
	listenPort      uint16
	allowedSources  []string
	routeGeneration uint64
	// maxConnections is the link's capacity: the session limit Gateway signed into the binding's grant. The listener
	// is the link's single gate on the node and holds it there whichever relay of the pool carries a connection; each
	// relay caps the route at the same limit, so any one of them can carry the whole link. A grant refresh changes it
	// on the running listener; it is not part of the listener's identity (equal), so a new limit never drops a
	// connection.
	maxConnections int
}

type managedDatabaseHostListenerStatus struct {
	Address string `json:"address"`
	Port    uint16 `json:"port"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
}

type managedDatabaseHostListener struct {
	listener *net.TCPListener
	mu       sync.Mutex
	// config changes in place when only the limit or the binding changes (re-key on an Availability adopt).
	config      managedDatabaseHostListenerConfig
	closed      bool
	connections map[net.Conn]struct{}
}

type managedDatabaseHostListenerManager struct {
	plugin           *DockerPlugin
	logger           *slog.Logger
	mu               sync.Mutex
	listeners        map[string]*managedDatabaseHostListener
	global           chan struct{}
	inspectNetwork   func(context.Context, string) (network.Inspect, error)
	inspectContainer func(context.Context, string) (mobyclient.ContainerInspectResult, error)
	openBinding      func(net.Conn, string, uint64)
	rejections       *linkRejectionLog
}

func newManagedDatabaseHostListenerManager(plugin *DockerPlugin) *managedDatabaseHostListenerManager {
	manager := &managedDatabaseHostListenerManager{
		plugin:    plugin,
		logger:    plugin.logger,
		listeners: map[string]*managedDatabaseHostListener{},
		global:    make(chan struct{}, managedDatabaseHostListenerGlobalConnections),
		// The plugin's log: the health report counts what the listeners refuse.
		rejections: &plugin.linkRejections,
	}
	manager.inspectNetwork = func(ctx context.Context, name string) (network.Inspect, error) {
		inspected, err := plugin.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
		return inspected.Network, err
	}
	manager.inspectContainer = func(ctx context.Context, id string) (mobyclient.ContainerInspectResult, error) {
		return plugin.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	}
	manager.openBinding = plugin.openManagedDatabaseBinding
	return manager
}

func (m *managedDatabaseHostListenerManager) reconcile(
	ctx context.Context,
	bundle *pb.SyncRelayGrantsCommand,
) map[string]managedDatabaseHostListenerStatus {
	desired, statuses := m.desired(bundle)
	resolved := make(map[string]managedDatabaseHostListenerConfig, len(desired))
	// unverified holds the bindings whose network could not be inspected now. Their running listeners stay and
	// report the error; only a sync that inspects the network again replaces or closes them.
	unverified := map[string]managedDatabaseHostListenerConfig{}
	for bindingID, config := range desired {
		resolvedConfig, err := m.resolve(ctx, config)
		if err != nil {
			statuses[bindingID] = listenerStatus(config, "error", err)
			if errors.Is(err, errManagedDatabaseListenerUnverified) {
				unverified[bindingID] = config
			}
			continue
		}
		resolved[bindingID] = resolvedConfig
	}

	for _, bindingIDs := range duplicateListenerAddresses(resolved) {
		for _, bindingID := range bindingIDs {
			config := resolved[bindingID]
			statuses[bindingID] = listenerStatus(config, "error", errors.New("managed database listeners cannot share an address and port"))
			delete(resolved, bindingID)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	// released are the listeners of bindings that left the bundle. One may serve on as another binding.
	var released []*managedDatabaseHostListener
	for bindingID, listener := range m.listeners {
		current := listener.currentConfig()
		if config, present := resolved[bindingID]; present && current.equal(config) {
			listener.setConfig(config)
			statuses[bindingID] = listenerStatus(config, "ready", nil)
			continue
		}
		if config, present := unverified[bindingID]; present {
			config.networkID = current.networkID
			if current.equal(config) {
				listener.setConfig(config)
				continue
			}
		}
		delete(m.listeners, bindingID)
		_, stillDesired := desired[bindingID]
		_, stillListed := statuses[bindingID]
		if !stillDesired && !stillListed {
			released = append(released, listener)
			continue
		}
		listener.close()
	}
	for _, listener := range released {
		previous := listener.currentConfig()
		next, verified, found := m.successorLocked(previous, resolved, unverified)
		if !found {
			listener.close()
			continue
		}
		// An Availability adopt or release moves the binding's route to another binding id with the same network,
		// address, sources and route generation: the listener serves on under the new id and keeps its connections.
		listener.setConfig(next)
		m.listeners[next.bindingID] = listener
		if verified {
			statuses[next.bindingID] = listenerStatus(next, "ready", nil)
		}
		m.logger.Info("managed database host listener moved to another binding", "from_binding_id", previous.bindingID,
			"binding_id", next.bindingID, "address", net.JoinHostPort(next.listenAddress.String(), fmt.Sprintf("%d", next.listenPort)))
	}
	for bindingID, config := range resolved {
		if _, exists := m.listeners[bindingID]; exists {
			continue
		}
		listener, err := m.listen(config)
		if err != nil {
			statuses[bindingID] = listenerStatus(config, "error", err)
			continue
		}
		m.listeners[bindingID] = listener
		statuses[bindingID] = listenerStatus(config, "ready", nil)
	}
	return statuses
}

// successorLocked finds the binding a released listener serves on as: one without a listener whose config is the
// listener's except for the binding id. verified reports a successor whose network was inspected now.
func (m *managedDatabaseHostListenerManager) successorLocked(
	previous managedDatabaseHostListenerConfig,
	resolved, unverified map[string]managedDatabaseHostListenerConfig,
) (next managedDatabaseHostListenerConfig, verified bool, found bool) {
	passes := []struct {
		candidates map[string]managedDatabaseHostListenerConfig
		verified   bool
	}{{resolved, true}, {unverified, false}}
	for _, pass := range passes {
		bindingIDs := make([]string, 0, len(pass.candidates))
		for bindingID := range pass.candidates {
			bindingIDs = append(bindingIDs, bindingID)
		}
		sort.Strings(bindingIDs)
		for _, bindingID := range bindingIDs {
			if _, exists := m.listeners[bindingID]; exists {
				continue
			}
			candidate := pass.candidates[bindingID]
			if !pass.verified {
				candidate.networkID = previous.networkID
			}
			moved := previous
			moved.bindingID = bindingID
			if moved.equal(candidate) {
				return candidate, pass.verified, true
			}
		}
	}
	return managedDatabaseHostListenerConfig{}, false, false
}

func (m *managedDatabaseHostListenerManager) desired(bundle *pb.SyncRelayGrantsCommand) (map[string]managedDatabaseHostListenerConfig, map[string]managedDatabaseHostListenerStatus) {
	desired := map[string]managedDatabaseHostListenerConfig{}
	statuses := map[string]managedDatabaseHostListenerStatus{}
	if bundle == nil {
		return desired, statuses
	}
	for _, assignment := range bundle.GetGrants() {
		if assignment == nil || assignment.GetManagedDatabaseListener() == nil {
			continue
		}
		bindingID := assignment.GetOwnerId()
		config, err := managedDatabaseHostListenerConfigFromAssignment(assignment)
		if err != nil {
			statuses[bindingID] = managedDatabaseHostListenerStatus{State: "error", Error: err.Error()}
			continue
		}
		if _, exists := desired[config.bindingID]; exists {
			statuses[config.bindingID] = listenerStatus(config, "error", errors.New("duplicate managed database listener binding"))
			delete(desired, config.bindingID)
			continue
		}
		desired[config.bindingID] = config
	}
	return desired, statuses
}

func managedDatabaseHostListenerConfigFromAssignment(assignment *pb.RelayGrantAssignment) (managedDatabaseHostListenerConfig, error) {
	listener := assignment.GetManagedDatabaseListener()
	if assignment.GetRole() != "connect" || assignment.GetOwnerKind() != "managed_database_binding" {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener requires a connect binding assignment")
	}
	if !managedDatabaseIDPattern.MatchString(assignment.GetOwnerId()) {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener binding id is invalid")
	}
	if listener == nil || !strings.HasPrefix(listener.GetNetworkName(), "gateway-db-") {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener network is invalid")
	}
	address, err := netip.ParseAddr(listener.GetListenAddress())
	if err != nil || !address.Is4() {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener address must be IPv4")
	}
	if listener.GetListenPort() == 0 || listener.GetListenPort() > 65535 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener port is invalid")
	}
	if listener.GetRouteGeneration() == 0 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener route generation is required")
	}
	if assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener relay grant is unavailable")
	}
	allowed, err := normalizedManagedDatabaseAllowedSources(listener.GetAllowedSources())
	if err != nil {
		return managedDatabaseHostListenerConfig{}, err
	}
	return managedDatabaseHostListenerConfig{
		bindingID: assignment.GetOwnerId(), networkName: listener.GetNetworkName(), listenAddress: address,
		listenPort: uint16(listener.GetListenPort()), allowedSources: allowed, routeGeneration: listener.GetRouteGeneration(),
		maxConnections: int(relayGrantSessionLimit(assignment, managedLinkDefaultSessions)),
	}, nil
}

// relayGrantSessionLimit reads the session limit Gateway signed into an assignment's grants, or fallback when they name
// none. The relay verifies the grant and enforces the limit per route; the daemon holds the whole link at it.
func relayGrantSessionLimit(assignment *pb.RelayGrantAssignment, fallback uint32) uint32 {
	grants := []*pb.RelaySignedGrant{assignment.GetGrant()}
	for _, candidate := range assignment.GetCandidates() {
		grants = append(grants, candidate.GetGrant())
	}
	limit := uint32(0)
	for _, grant := range grants {
		if len(grant.GetPayload()) == 0 {
			continue
		}
		var claims struct {
			MaxConcurrentSessions uint32 `json:"maxConcurrentSessions"`
		}
		if json.Unmarshal(grant.GetPayload(), &claims) == nil && claims.MaxConcurrentSessions > limit {
			limit = claims.MaxConcurrentSessions
		}
	}
	if limit == 0 {
		return fallback
	}
	return limit
}

func normalizedManagedDatabaseAllowedSources(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > 32 {
		return nil, errors.New("managed database listener allowed sources are invalid")
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !validManagedDatabaseSource(value) {
			return nil, errors.New("managed database listener source selector is invalid")
		}
		if _, exists := seen[value]; exists {
			return nil, errors.New("managed database listener source selectors must be unique")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func validManagedDatabaseSource(value string) bool {
	kind, identity, found := strings.Cut(value, ":")
	if !found || identity == "" {
		return false
	}
	switch kind {
	case "container":
		return managedDatabaseHostContainerName.MatchString(identity)
	case "deployment":
		return managedDatabaseIDPattern.MatchString(identity)
	case "compose":
		project, service, present := strings.Cut(identity, ":")
		return present && managedDatabaseHostContainerName.MatchString(project) && managedDatabaseHostContainerName.MatchString(service)
	default:
		return false
	}
}

func (m *managedDatabaseHostListenerManager) resolve(ctx context.Context, config managedDatabaseHostListenerConfig) (managedDatabaseHostListenerConfig, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, managedDatabaseHostListenerInspectTimeout)
	defer cancel()
	inspected, err := m.inspectNetwork(inspectCtx, config.networkName)
	if isNotFoundErr(err) {
		return config, fmt.Errorf("managed database listener network %s does not exist: %w", config.networkName, err)
	}
	if err != nil {
		return config, fmt.Errorf("%w: %w", errManagedDatabaseListenerUnverified, err)
	}
	if inspected.Name != config.networkName || inspected.ID == "" || inspected.Driver != "bridge" || inspected.Ingress || inspected.ConfigOnly {
		return config, errors.New("managed database listener network is not a dedicated bridge network")
	}
	gateway, err := managedDatabaseNetworkGatewayAddress(inspected)
	if err != nil {
		return config, err
	}
	if gateway != config.listenAddress {
		return config, errors.New("managed database listener address is not the network gateway")
	}
	config.networkID = inspected.ID
	return config, nil
}

func managedDatabaseNetworkGatewayAddress(inspected network.Inspect) (netip.Addr, error) {
	for _, config := range inspected.IPAM.Config {
		if config.Gateway.IsValid() && config.Gateway.Is4() {
			return config.Gateway, nil
		}
	}
	return netip.Addr{}, errors.New("managed database network has no IPv4 gateway")
}

func duplicateListenerAddresses(configs map[string]managedDatabaseHostListenerConfig) map[string][]string {
	byAddress := map[string][]string{}
	for bindingID, config := range configs {
		address := net.JoinHostPort(config.listenAddress.String(), fmt.Sprintf("%d", config.listenPort))
		byAddress[address] = append(byAddress[address], bindingID)
	}
	duplicates := map[string][]string{}
	for address, bindingIDs := range byAddress {
		if len(bindingIDs) > 1 {
			duplicates[address] = bindingIDs
		}
	}
	return duplicates
}

func (m *managedDatabaseHostListenerManager) listen(config managedDatabaseHostListenerConfig) (*managedDatabaseHostListener, error) {
	addressBytes := config.listenAddress.As4()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(addressBytes[0], addressBytes[1], addressBytes[2], addressBytes[3]), Port: int(config.listenPort)})
	if err != nil {
		return nil, fmt.Errorf("listen on managed database gateway: %w", err)
	}
	managedListener := &managedDatabaseHostListener{config: config, listener: listener, connections: map[net.Conn]struct{}{}}
	go m.accept(managedListener)
	return managedListener, nil
}

func (m *managedDatabaseHostListenerManager) accept(listener *managedDatabaseHostListener) {
	for {
		connection, err := listener.listener.AcceptTCP()
		if err != nil {
			return
		}
		if !m.acquire(listener, connection) {
			_ = connection.Close()
			continue
		}
		go m.handle(listener, connection)
	}
}

func (m *managedDatabaseHostListenerManager) acquire(listener *managedDatabaseHostListener, connection net.Conn) bool {
	select {
	case m.global <- struct{}{}:
	default:
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, listener.currentConfig().bindingID, linkRejectedNodeLimit,
			"limit", cap(m.global))
		return false
	}
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		<-m.global
		return false
	}
	if limit := listener.config.maxConnections; len(listener.connections) >= limit {
		bindingID := listener.config.bindingID
		listener.mu.Unlock()
		<-m.global
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedLinkLimit, "limit", limit)
		return false
	}
	listener.connections[connection] = struct{}{}
	listener.mu.Unlock()
	return true
}

func (m *managedDatabaseHostListenerManager) handle(listener *managedDatabaseHostListener, connection net.Conn) {
	defer func() {
		listener.mu.Lock()
		delete(listener.connections, connection)
		listener.mu.Unlock()
		<-m.global
		_ = connection.Close()
	}()
	config := listener.currentConfig()
	reject := func(reason string, attrs ...any) {
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, config.bindingID, reason, attrs...)
	}
	remote, ok := connection.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return
	}
	remoteAddress, ok := netip.AddrFromSlice(remote.IP)
	if !ok || !remoteAddress.Unmap().Is4() {
		reject(linkRejectedUnknownPeer, "peer", remote.IP.String())
		return
	}
	inspectCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseHostListenerInspectTimeout)
	defer cancel()
	inspected, err := m.inspectNetwork(inspectCtx, config.networkName)
	if err != nil {
		reject(linkRejectedNetworkUnverified, "error", err.Error())
		return
	}
	if inspected.Name != config.networkName || inspected.ID != config.networkID {
		reject(linkRejectedNetworkChanged)
		return
	}
	if gateway, gatewayErr := managedDatabaseNetworkGatewayAddress(inspected); gatewayErr != nil || gateway != config.listenAddress {
		reject(linkRejectedNetworkChanged)
		return
	}
	containerID := managedDatabaseListenerPeerContainerID(inspected, remoteAddress.Unmap())
	if containerID == "" {
		reject(linkRejectedUnknownPeer, "peer", remoteAddress.Unmap().String())
		return
	}
	containerInspect, err := m.inspectContainer(inspectCtx, containerID)
	if err != nil {
		reject(linkRejectedNetworkUnverified, "error", err.Error())
		return
	}
	if !managedDatabaseListenerSourceAllowed(containerInspect, config.allowedSources) {
		reject(linkRejectedSourceNotAllowed, "container", strings.TrimPrefix(containerInspect.Container.Name, "/"))
		return
	}
	// A re-key while the peer was checked moved the listener to another binding with the same network and sources:
	// the connection belongs to the binding the listener serves now.
	listener.mu.Lock()
	active, current := !listener.closed, listener.config
	listener.mu.Unlock()
	if active {
		m.openBinding(connection, current.bindingID, current.routeGeneration)
	}
}

// activeConnections returns the connections each binding's listener holds, by binding id.
func (m *managedDatabaseHostListenerManager) activeConnections() map[string]int {
	m.mu.Lock()
	listeners := make(map[string]*managedDatabaseHostListener, len(m.listeners))
	for bindingID, listener := range m.listeners {
		listeners[bindingID] = listener
	}
	m.mu.Unlock()
	result := make(map[string]int, len(listeners))
	for bindingID, listener := range listeners {
		listener.mu.Lock()
		result[bindingID] = len(listener.connections)
		listener.mu.Unlock()
	}
	return result
}

func managedDatabaseListenerPeerContainerID(inspected network.Inspect, remote netip.Addr) string {
	for containerID, endpoint := range inspected.Containers {
		if !endpoint.IPv4Address.IsValid() {
			continue
		}
		if endpoint.IPv4Address.Addr().Unmap() == remote {
			return containerID
		}
	}
	return ""
}

func managedDatabaseListenerSourceAllowed(inspected mobyclient.ContainerInspectResult, allowed []string) bool {
	name := strings.TrimPrefix(inspected.Container.Name, "/")
	labels := inspected.Container.Config.Labels
	for _, selector := range allowed {
		kind, identity, _ := strings.Cut(selector, ":")
		switch kind {
		case "container":
			if name == identity {
				return true
			}
		case "deployment":
			if labels[deploymentManagedLabel] == "true" && labels[deploymentIDLabel] == identity {
				return true
			}
		case "compose":
			project, service, _ := strings.Cut(identity, ":")
			if labels["com.docker.compose.project"] == project && labels["com.docker.compose.service"] == service {
				return true
			}
		}
	}
	return false
}

func (listener *managedDatabaseHostListener) currentConfig() managedDatabaseHostListenerConfig {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return listener.config
}

func (listener *managedDatabaseHostListener) setConfig(config managedDatabaseHostListenerConfig) {
	listener.mu.Lock()
	listener.config = config
	listener.mu.Unlock()
}

func (listener *managedDatabaseHostListener) close() {
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		return
	}
	listener.closed = true
	connections := make([]net.Conn, 0, len(listener.connections))
	for connection := range listener.connections {
		connections = append(connections, connection)
	}
	listener.mu.Unlock()
	_ = listener.listener.Close()
	for _, connection := range connections {
		_ = connection.Close()
	}
}

func (config managedDatabaseHostListenerConfig) equal(other managedDatabaseHostListenerConfig) bool {
	if config.bindingID != other.bindingID || config.networkName != other.networkName || config.networkID != other.networkID ||
		config.listenAddress != other.listenAddress || config.listenPort != other.listenPort || config.routeGeneration != other.routeGeneration ||
		len(config.allowedSources) != len(other.allowedSources) {
		return false
	}
	for index := range config.allowedSources {
		if config.allowedSources[index] != other.allowedSources[index] {
			return false
		}
	}
	return true
}

func listenerStatus(config managedDatabaseHostListenerConfig, state string, err error) managedDatabaseHostListenerStatus {
	status := managedDatabaseHostListenerStatus{Address: config.listenAddress.String(), Port: config.listenPort, State: state}
	if err != nil {
		status.Error = err.Error()
	}
	return status
}
