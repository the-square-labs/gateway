package docker

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

// syncConnectorLocked sends ingress to the connector together with the egress listeners it already holds, which a
// sync of the ingress side therefore leaves as they are.
func (m *dockerSecureLinkManager) syncConnectorLocked(ctx context.Context, ingress []securelink.BindingConfig) (*securelink.SyncResponse, error) {
	var egress []securelink.EgressConfig
	if m.egress.configsFor == m.connectorID {
		egress = m.egress.configs
	}
	response, err := securelink.Sync(ctx, m.socketPath, ingress, egress)
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
			if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.connectorID, Force: true}); err != nil && !isNotFoundErr(err) {
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
	m.egress.publish(m.reconcileEgressStatusesLocked(ctx, true))
}

func (m *dockerSecureLinkManager) reconcileEgressStatusesLocked(ctx context.Context, mayReplace bool) map[string]egressStatus {
	statuses := map[string]egressStatus{}
	for id, status := range m.egress.rejected {
		statuses[id] = status
	}
	if !m.egress.wanted() {
		m.dropEgressLocked(ctx)
		return statuses
	}
	pending := func(reason string) map[string]egressStatus {
		for id, desired := range m.egress.desired {
			statuses[id] = egressStatus{State: egressStatePending, Error: reason, RouteGeneration: desired.generation, network: desired.networkName}
		}
		return statuses
	}
	connectorNetworks, runningImage, err := m.egressConnectorLocked(ctx)
	if err != nil {
		return pending(err.Error())
	}
	ids := make([]string, 0, len(m.egress.desired))
	for id := range m.egress.desired {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	attached := map[string]egressNetwork{}
	changed := false
	for _, id := range ids {
		desired := m.egress.desired[id]
		info, reattached, state, err := m.attachEgressLocked(ctx, desired, connectorNetworks[desired.networkName])
		if err != nil {
			statuses[id] = egressStatus{State: state, Error: err.Error(), RouteGeneration: desired.generation, network: desired.networkName}
			continue
		}
		changed = changed || reattached
		attached[id] = info
	}
	if changed {
		reinspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return pending(fmt.Sprintf("inspect secure-link connector: %v", err))
		}
		connectorNetworks = connectorNetworksOf(reinspected.Container.NetworkSettings)
	}
	configs := make([]securelink.EgressConfig, 0, len(attached))
	for _, id := range ids {
		info, ok := attached[id]
		if !ok {
			continue
		}
		desired := m.egress.desired[id]
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
	response, err := securelink.Sync(ctx, m.socketPath, ingress, configs)
	if response == nil {
		for _, config := range configs {
			statuses[config.ID] = egressStatus{State: egressStateError, Error: fmt.Sprintf("secure-link connector sync: %v", err),
				RouteGeneration: config.Generation, network: m.egress.desired[config.ID].networkName}
		}
		return statuses
	}
	if response.Version < securelink.ProtocolVersion && mayReplace && !m.ingressWantedLocked() {
		// A connector of an earlier image serves no egress (D4). With ingress, the proxy secure-link sync owns the
		// image; without, the connector is started again with the image the egress names, once per sync.
		if image := m.egressImageLocked(); image != "" && image != runningImage {
			if err := m.removeConnector(ctx); err == nil {
				return m.reconcileEgressStatusesLocked(ctx, false)
			} else if m.plugin.logger != nil {
				m.plugin.logger.Warn("could not replace the secure-link connector of an earlier image", "error", err)
			}
		}
	}
	if err != nil && m.plugin.logger != nil {
		// The ingress bindings the connector holds were refused again; the next proxy secure-link sync deals with them.
		m.plugin.logger.Warn("secure-link connector refused its ingress bindings during an egress sync", "error", err)
	}
	m.recordEgressResponseLocked(response, configs, statuses)
	m.detachStaleEgressNetworksLocked(ctx, connectorNetworks)
	return statuses
}

// recordEgressResponseLocked turns the connector's answer into statuses.
func (m *dockerSecureLinkManager) recordEgressResponseLocked(response *securelink.SyncResponse, configs []securelink.EgressConfig, statuses map[string]egressStatus) {
	answered := make(map[string]securelink.EgressStatus, len(response.Egress))
	for _, status := range response.Egress {
		answered[status.ID] = status
	}
	for _, config := range configs {
		networkName := m.egress.desired[config.ID].networkName
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

// egressConnectorLocked returns the networks and image of the running connector, started for egress when there is
// none.
func (m *dockerSecureLinkManager) egressConnectorLocked(ctx context.Context) (map[string]*network.EndpointSettings, string, error) {
	if m.connectorID != "" {
		inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
		if err == nil && inspected.Container.State != nil && inspected.Container.State.Running {
			return connectorNetworksOf(inspected.Container.NetworkSettings), connectorImageOf(inspected.Container), nil
		}
		if err != nil && !isNotFoundErr(err) {
			return nil, "", fmt.Errorf("inspect secure-link connector: %w", err)
		}
	}
	image := m.egressImageLocked()
	if image == "" && m.connectorID == "" {
		return nil, "", errors.New("no secure-link connector image is known on this node yet")
	}
	if image == "" {
		return nil, "", errors.New("the secure-link connector is not running")
	}
	replacement, err := m.ensureConnector(ctx, image)
	if err != nil {
		return nil, "", fmt.Errorf("start the secure-link connector: %w", err)
	}
	if replacement != nil {
		// Only a serving connector is replaced, and it serves ingress: the next proxy secure-link sync switches.
		m.abortReplacement(replacement)
		return nil, "", errors.New("the secure-link connector is being replaced")
	}
	if m.ingressWantedLocked() {
		// A connector started here lost the ingress bindings of the one before: bind them again once this sync is done.
		go func() { _ = m.restoreBindingsCoalesced(true) }()
	}
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, "", fmt.Errorf("inspect secure-link connector: %w", err)
	}
	return connectorNetworksOf(inspected.Container.NetworkSettings), connectorImageOf(inspected.Container), nil
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
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, desired.networkName, mobyclient.NetworkDisconnectOptions{Container: m.connectorID, Force: true}); err != nil && !isNotFoundErr(err) {
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
	if _, err := m.plugin.client.cli.NetworkConnect(ctx, desired.networkName, mobyclient.NetworkConnectOptions{Container: m.connectorID, EndpointConfig: settings}); err != nil {
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
		if !endpoint.IPv4Address.IsValid() || endpoint.IPv4Address.Addr() != reserved || id == m.connectorID {
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
		if _, err := securelink.Sync(ctx, m.socketPath, ingress, nil); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector did not take the removal of its egress listeners", "error", err)
		}
	}
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
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
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.connectorID, Force: true}); err != nil && !isNotFoundErr(err) {
			if m.plugin.logger != nil {
				m.plugin.logger.Warn("could not detach the secure-link connector from a link network it no longer serves", "network", name, "error", err)
			}
			continue
		}
		delete(m.attached, name)
		delete(m.egress.networks, name)
	}
}
