package docker

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

// connectorRequest is a connector sync: every one names the daemon's address towards the connector as the only peer
// of its ingress listeners.
func (m *dockerSecureLinkManager) connectorRequest(ingress []securelink.BindingConfig, egress []securelink.EgressConfig) securelink.SyncRequest {
	return securelink.SyncRequest{Bindings: ingress, Egress: egress, IngressPeer: m.managementGateway}
}

// syncConnectorLocked sends ingress to the connector together with the egress listeners it already holds, which a
// sync of the ingress side therefore leaves as they are.
func (m *dockerSecureLinkManager) syncConnectorLocked(ctx context.Context, ingress []securelink.BindingConfig) (*securelink.SyncResponse, error) {
	var egress []securelink.EgressConfig
	if m.egress.configsFor == m.connectorID {
		egress = m.egress.configs
	}
	response, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, egress))
	if err == nil {
		m.egress.ingressConfigs, m.egress.ingressFor = ingress, m.connectorID
	}
	return response, err
}

// releaseIngressLocked leaves the connector without ingress bindings. It is removed with its management network
// unless it serves egress (D5).
func (m *dockerSecureLinkManager) releaseIngressLocked(ctx context.Context) error {
	m.egress.ingressConfigs, m.egress.ingressNetworks = nil, nil
	if !m.egress.wanted() {
		return m.removeConnector(ctx)
	}
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
	if m.connectorID != "" {
		if _, err := m.syncConnectorLocked(ctx, nil); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector did not take the release of its ingress bindings", "error", err)
		}
		// The target networks of the released bindings: the connector stays on its link networks only.
		for name := range m.attached {
			if m.egress.networkDesired(name) {
				continue
			}
			if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
				return fmt.Errorf("detach secure-link connector from %s: %w", name, err)
			}
			delete(m.attached, name)
		}
	}
	m.reconcileEgressLocked(ctx)
	return nil
}

// releaseIngress is releaseIngressLocked for the startup cleanup of an interrupted teardown.
func (m *dockerSecureLinkManager) releaseIngress(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.releaseIngressLocked(ctx)
}

// reconcileEgressLocked brings the connector's egress to the desired set: the connector exists while it has ingress
// or egress, joins each link network with the link's alias (its reserved address on a network of
// create_link_network), and listens on its address there. Every failure is the status of its own egress.
func (m *dockerSecureLinkManager) reconcileEgressLocked(ctx context.Context) {
	if m.plugin == nil || m.plugin.client == nil {
		return
	}
	statuses := m.reconcileEgressStatusesLocked(ctx)
	// Orphans keep their listeners but are no longer Gateway's to hear about.
	for id := range statuses {
		_, desired := m.egress.desired[id]
		_, rejected := m.egress.rejected[id]
		if !desired && !rejected {
			delete(statuses, id)
		}
	}
	m.egress.publish(statuses)
}

func (m *dockerSecureLinkManager) reconcileEgressStatusesLocked(ctx context.Context) map[string]egressStatus {
	statuses := map[string]egressStatus{}
	for id, status := range m.egress.rejected {
		statuses[id] = status
	}
	serving := m.egress.serving(time.Now())
	if len(serving) == 0 {
		m.dropEgressLocked(ctx)
		return statuses
	}
	pending := func(reason string) map[string]egressStatus {
		for id, desired := range serving {
			statuses[id] = egressStatus{State: egressStatePending, Error: reason, RouteGeneration: desired.generation, network: desired.networkName}
		}
		return statuses
	}
	connectorNetworks, _, replacement, err := m.egressConnectorLocked(ctx)
	if err != nil {
		return pending(err.Error())
	}
	ids := make([]string, 0, len(serving))
	for id := range serving {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	attached := map[string]egressNetwork{}
	changed := false
	for _, id := range ids {
		desired := serving[id]
		info, reattached, state, err := m.attachEgressLocked(ctx, desired, connectorNetworks[desired.networkName])
		if err != nil {
			statuses[id] = egressStatus{State: state, Error: err.Error(), RouteGeneration: desired.generation, network: desired.networkName}
			continue
		}
		changed = changed || reattached
		attached[id] = info
	}
	if changed {
		reinspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
		if err != nil {
			if replacement != nil {
				m.abortReplacement(replacement)
			}
			return pending(fmt.Sprintf("inspect secure-link anchor: %v", err))
		}
		connectorNetworks = connectorNetworksOf(reinspected.Container.NetworkSettings)
	}
	configs := make([]securelink.EgressConfig, 0, len(attached))
	for _, id := range ids {
		info, ok := attached[id]
		if !ok {
			continue
		}
		desired := serving[id]
		endpoint := connectorNetworks[desired.networkName]
		if endpoint == nil || !endpoint.IPAddress.IsValid() || !endpoint.IPAddress.Is4() || !info.prefix.Contains(endpoint.IPAddress) {
			statuses[id] = egressStatus{State: egressStatePending, Error: "the connector has no address on the link network yet",
				RouteGeneration: desired.generation, network: desired.networkName}
			continue
		}
		configs = append(configs, securelink.EgressConfig{
			ID: id, OwnerKind: desired.ownerKind, Generation: desired.generation, ListenHost: endpoint.IPAddress.String(),
			ListenPort: desired.listenPort, AllowedPrefix: info.prefix.String(), MaxSessions: desired.maxSessions,
			TLSCAPEM: desired.tlsCAPEM, TLSServerName: desired.tlsName,
		})
	}
	m.egress.configs, m.egress.configsFor = configs, m.connectorID
	ingress := m.egress.ingressConfigs
	if m.egress.ingressFor != m.connectorID {
		ingress = nil
	}
	response, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, configs))
	if replacement != nil {
		if response == nil || response.Version < securelink.ProtocolVersion {
			// The new connector took nothing: the previous one serves on as before.
			m.abortReplacement(replacement)
			m.egress.configsFor = m.connectorID
		} else {
			// The egress listens on the new connector too (SO_REUSEPORT): the previous one stops accepting and drains.
			m.retireConnector(replacement.previous)
		}
	}
	if response == nil {
		for _, config := range configs {
			statuses[config.ID] = egressStatus{State: egressStateError, Error: fmt.Sprintf("secure-link connector sync: %v", err),
				RouteGeneration: config.Generation, network: serving[config.ID].networkName}
		}
		return statuses
	}
	if err != nil && m.plugin.logger != nil {
		// The ingress bindings the connector holds were refused again; the next proxy secure-link sync deals with them.
		m.plugin.logger.Warn("secure-link connector refused its ingress bindings during an egress sync", "error", err)
	}
	m.recordEgressResponseLocked(response, configs, serving, statuses)
	m.detachStaleEgressNetworksLocked(ctx, connectorNetworks)
	return statuses
}

// recordEgressResponseLocked turns the connector's answer into statuses.
func (m *dockerSecureLinkManager) recordEgressResponseLocked(response *securelink.SyncResponse, configs []securelink.EgressConfig, serving map[string]egressDesired, statuses map[string]egressStatus) {
	answered := make(map[string]securelink.EgressStatus, len(response.Egress))
	for _, status := range response.Egress {
		answered[status.ID] = status
	}
	for _, config := range configs {
		networkName := serving[config.ID].networkName
		status := egressStatus{RouteGeneration: config.Generation, network: networkName}
		answer, ok := answered[config.ID]
		switch {
		case response.Version < securelink.ProtocolVersion:
			status.State, status.Error = egressStateError, "the secure-link connector image does not serve egress: it needs the connector image of this Gateway release"
		case !ok:
			status.State, status.Error = egressStateError, "the secure-link connector did not report the egress listener"
		case answer.State == securelink.EgressListening && answer.Generation == config.Generation:
			status.State, status.Address, status.Port = egressStateReady, config.ListenHost, config.ListenPort
		default:
			status.State, status.Error = egressStateError, answer.Error
			if status.Error == "" {
				status.Error = "the secure-link connector did not listen for the egress"
			}
		}
		statuses[config.ID] = status
	}
}

// egressConnectorLocked brings the connector and its anchor up for the egress and returns the anchor's networks, the
// connector's image, and the replacement it started for another egress image (a node without ingress), which the
// caller retires once the egress listens on the new connector. With ingress, the proxy secure-link sync owns the
// image: the running connector keeps its own.
func (m *dockerSecureLinkManager) egressConnectorLocked(ctx context.Context) (map[string]*network.EndpointSettings, string, *connectorReplacement, error) {
	ingress := m.ingressWantedLocked()
	var running *container.InspectResponse
	if m.connectorID != "" {
		inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
		if err != nil && !isNotFoundErr(err) {
			return nil, "", nil, fmt.Errorf("inspect secure-link connector: %w", err)
		}
		if err == nil && inspected.Container.State != nil && inspected.Container.State.Running {
			running = &inspected.Container
		}
	}
	image := m.egressImageLocked()
	if running != nil && (ingress || image == "") {
		image = connectorImageOf(*running)
	}
	if image == "" {
		return nil, "", nil, errors.New("no secure-link connector image is known on this node yet")
	}
	replacement, err := m.ensureConnector(ctx, image)
	if err != nil {
		return nil, "", nil, fmt.Errorf("start the secure-link connector: %w", err)
	}
	if replacement != nil && (ingress || m.anchorID == "") {
		// Its ingress bindings must move with it: the next proxy secure-link sync replaces it.
		m.abortReplacement(replacement)
		replacement = nil
	}
	if ingress && (running == nil || running.ID != m.connectorID) {
		// A connector started here holds none of the ingress bindings: bind them again once this sync is done.
		go func() { _ = m.restoreBindingsCoalesced(true) }()
	}
	if m.anchorID == "" {
		// Gateway still sends the connector image of an earlier release: the connector serves ingress in its own
		// namespace, and the egress waits for an image with the anchor.
		return nil, "", nil, errors.New(connectorImageTooOld)
	}
	networks, err := m.anchorNetworks(ctx)
	if err != nil {
		if replacement != nil {
			m.abortReplacement(replacement)
		}
		return nil, "", nil, err
	}
	return networks, image, replacement, nil
}

// servingLocked reports a connector carrying links: ingress bindings or egress listeners. Another image starts next
// to it instead of replacing it in place.
func (m *dockerSecureLinkManager) servingLocked() bool {
	return len(m.bindings) > 0 || (m.egress.configsFor == m.connectorID && len(m.egress.configs) > 0)
}

func connectorImageOf(inspect container.InspectResponse) string {
	if inspect.Config == nil {
		return ""
	}
	return inspect.Config.Image
}

func connectorNetworksOf(settings *container.NetworkSettings) map[string]*network.EndpointSettings {
	if settings == nil || settings.Networks == nil {
		return map[string]*network.EndpointSettings{}
	}
	return settings.Networks
}

// attachEgressLocked joins the connector to the link network with the link's alias, at its reserved address on a
// network of create_link_network. It reports whether it attached now, and the egress state of an error.
func (m *dockerSecureLinkManager) attachEgressLocked(ctx context.Context, desired egressDesired, endpoint *network.EndpointSettings) (egressNetwork, bool, string, error) {
	info, known := m.egress.networks[desired.networkName]
	if !known || endpoint == nil || endpoint.NetworkID != info.id {
		inspected, err := m.plugin.client.cli.NetworkInspect(ctx, desired.networkName, mobyclient.NetworkInspectOptions{})
		if isNotFoundErr(err) {
			return egressNetwork{}, false, egressStatePending, errors.New("the link network does not exist yet")
		}
		if err != nil {
			return egressNetwork{}, false, egressStatePending, fmt.Errorf("inspect the link network: %w", err)
		}
		if info, err = egressNetworkOf(inspected.Network); err != nil {
			return egressNetwork{}, false, egressStateError, err
		}
		if m.egress.networks == nil {
			m.egress.networks = map[string]egressNetwork{}
		}
		m.egress.networks[desired.networkName] = info
		if known && endpoint != nil && endpoint.NetworkID != info.id {
			// The network was created again under the same name: the endpoint belongs to the removed one.
			endpoint = nil
		}
	}
	if endpoint != nil && endpoint.NetworkID == info.id && endpointHasAlias(endpoint, desired.alias) &&
		(!info.reserved.IsValid() || endpoint.IPAddress == info.reserved) {
		return info, false, "", nil
	}
	if endpoint != nil {
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, desired.networkName, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
			return egressNetwork{}, false, egressStateError, fmt.Errorf("detach the connector to rejoin the link network: %w", err)
		}
	}
	settings := &network.EndpointSettings{Aliases: []string{desired.alias}}
	if info.reserved.IsValid() {
		if err := m.freeReservedAddressLocked(ctx, desired.networkName, info.reserved); err != nil {
			return egressNetwork{}, false, egressStateError, err
		}
		settings.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: info.reserved}
	}
	if _, err := m.plugin.client.cli.NetworkConnect(ctx, desired.networkName, mobyclient.NetworkConnectOptions{Container: m.networkHolder(), EndpointConfig: settings}); err != nil {
		return egressNetwork{}, false, egressStateError, fmt.Errorf("attach the secure-link connector to the link network: %w", err)
	}
	if m.attached != nil {
		m.attached[desired.networkName] = struct{}{}
	}
	return info, true, "", nil
}

// freeReservedAddressLocked takes the connector's reserved address on a link network from the connector it is about
// to replace (the other slot, retiring): only one container holds an address. Any other holder is refused.
func (m *dockerSecureLinkManager) freeReservedAddressLocked(ctx context.Context, networkName string, reserved netip.Addr) error {
	inspected, err := m.plugin.client.cli.NetworkInspect(ctx, networkName, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect the link network: %w", err)
	}
	for id, endpoint := range inspected.Network.Containers {
		if !endpoint.IPv4Address.IsValid() || endpoint.IPv4Address.Addr() != reserved || id == m.networkHolder() {
			continue
		}
		if !isSecureLinkConnectorName(strings.TrimPrefix(endpoint.Name, "/")) {
			return fmt.Errorf("the connector address %s on the link network is held by another container", reserved)
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, networkName, mobyclient.NetworkDisconnectOptions{Container: id, Force: true}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("take the connector address from the replaced connector: %w", err)
		}
	}
	return nil
}

// egressNetworkOf checks a link network and reads its subnet and the connector's reserved address on it.
func egressNetworkOf(inspected network.Inspect) (egressNetwork, error) {
	if inspected.ID == "" || inspected.Driver != "bridge" || inspected.Ingress || inspected.ConfigOnly {
		return egressNetwork{}, errors.New("the link network is not a dedicated bridge network")
	}
	info := egressNetwork{id: inspected.ID}
	for _, config := range inspected.IPAM.Config {
		if config.Subnet.IsValid() && config.Subnet.Addr().Is4() {
			info.prefix = config.Subnet.Masked()
			break
		}
	}
	if !info.prefix.IsValid() {
		return egressNetwork{}, errors.New("the link network has no IPv4 subnet")
	}
	if reserved, ok := linkNetworkReservedAddress(inspected); ok {
		info.reserved = reserved
	}
	return info, nil
}

func endpointHasAlias(endpoint *network.EndpointSettings, alias string) bool {
	for _, name := range append(append([]string(nil), endpoint.Aliases...), endpoint.DNSNames...) {
		if name == alias {
			return true
		}
	}
	return false
}

// dropEgressLocked removes every egress listener; the connector goes when it serves nothing else.
func (m *dockerSecureLinkManager) dropEgressLocked(ctx context.Context) {
	hadEgress := len(m.egress.configs) > 0 && m.egress.configsFor == m.connectorID
	m.egress.configs, m.egress.configsFor = nil, ""
	if m.connectorID == "" {
		return
	}
	if !m.ingressWantedLocked() {
		if err := m.removeConnector(ctx); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("could not remove the secure-link connector without links", "error", err)
		}
		return
	}
	if hadEgress {
		ingress := m.egress.ingressConfigs
		if m.egress.ingressFor != m.connectorID {
			ingress = nil
		}
		if _, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, nil)); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector did not take the removal of its egress listeners", "error", err)
		}
	}
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
	if err == nil && inspected.Container.NetworkSettings != nil {
		m.detachStaleEgressNetworksLocked(ctx, inspected.Container.NetworkSettings.Networks)
	}
}

// detachStaleEgressNetworksLocked detaches the connector from the link networks no egress and no ingress binding
// uses any more.
func (m *dockerSecureLinkManager) detachStaleEgressNetworksLocked(ctx context.Context, connectorNetworks map[string]*network.EndpointSettings) {
	for name := range connectorNetworks {
		if !isEgressLinkNetwork(name) || m.egress.networkDesired(name) {
			continue
		}
		if _, ingress := m.egress.ingressNetworks[name]; ingress {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
			if m.plugin.logger != nil {
				m.plugin.logger.Warn("could not detach the secure-link connector from a link network it no longer serves", "network", name, "error", err)
			}
			continue
		}
		delete(m.attached, name)
		delete(m.egress.networks, name)
	}
}
