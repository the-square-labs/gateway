package docker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"strings"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func (c *Client) ListNetworks(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.NetworkList(ctx, client.NetworkListOptions{})
	if err != nil {
		return nil, fmt.Errorf("network list: %w", err)
	}
	// NetworkList doesn't populate Containers — inspect each to get them.
	type netWithContainers struct {
		network.Summary
		Containers map[string]network.EndpointResource `json:"Containers"`
	}
	// Build map of network ID/name → containers (including stopped) from container configs
	networkUsers := make(map[string]map[string]network.EndpointResource)
	ctrResult, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err == nil {
		for _, ctr := range ctrResult.Items {
			ctrName := ""
			if len(ctr.Names) > 0 {
				ctrName = strings.TrimPrefix(ctr.Names[0], "/")
			}
			for netName, netSettings := range ctr.NetworkSettings.Networks {
				if networkUsers[netName] == nil {
					networkUsers[netName] = make(map[string]network.EndpointResource)
				}
				networkUsers[netName][ctr.ID] = network.EndpointResource{
					Name: ctrName,
				}
				_ = netSettings
			}
		}
	}

	// Skip Docker built-in default networks
	hiddenNetworks := map[string]bool{"host": true, "none": true, "bridge": true}
	enriched := make([]netWithContainers, 0, len(result.Items))
	for _, n := range result.Items {
		if hiddenNetworks[n.Name] {
			continue
		}
		nwc := netWithContainers{Summary: n}
		// Merge: running containers from inspect + stopped containers from list
		inspected, inspErr := c.cli.NetworkInspect(ctx, n.ID, client.NetworkInspectOptions{})
		if inspErr == nil {
			nwc.Containers = inspected.Network.Containers
		} else {
			nwc.Containers = make(map[string]network.EndpointResource)
		}
		// Add stopped containers that aren't in the inspect result
		if users, ok := networkUsers[n.Name]; ok {
			for cid, ep := range users {
				if _, exists := nwc.Containers[cid]; !exists {
					nwc.Containers[cid] = ep
				}
			}
		}
		enriched = append(enriched, nwc)
	}
	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal networks: %w", err)
	}
	return data, nil
}

// CreateNetwork creates a network with the given parameters. Returns the network ID.
func (c *Client) CreateNetwork(ctx context.Context, name string, driver string, subnet string, gatewayAddr string) (string, error) {
	opts := client.NetworkCreateOptions{
		Driver: driver,
	}

	if subnet != "" {
		ipamCfg := network.IPAMConfig{}
		prefix, err := netip.ParsePrefix(subnet)
		if err != nil {
			return "", fmt.Errorf("parse subnet %q: %w", subnet, err)
		}
		ipamCfg.Subnet = prefix

		if gatewayAddr != "" {
			gw, err := netip.ParseAddr(gatewayAddr)
			if err != nil {
				return "", fmt.Errorf("parse gateway %q: %w", gatewayAddr, err)
			}
			ipamCfg.Gateway = gw
		}

		opts.IPAM = &network.IPAM{
			Config: []network.IPAMConfig{ipamCfg},
		}
	}

	result, err := c.cli.NetworkCreate(ctx, name, opts)
	if err != nil {
		return "", fmt.Errorf("network create: %w", err)
	}
	return result.ID, nil
}

// CreateReservedNetwork creates a bridge network whose automatic allocation
// range excludes a stable address reserved for a managed database connector.
// When subnet is empty, Docker first selects a non-overlapping subnet and the
// temporary empty network is immediately recreated with the bounded IPAM
// configuration before any endpoint can attach to it.
func (c *Client) CreateReservedNetwork(
	ctx context.Context,
	name string,
	driver string,
	subnet string,
	gatewayAddr string,
) (string, string, error) {
	if subnet == "" {
		probe, err := c.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: driver})
		if err != nil {
			return "", "", fmt.Errorf("network address probe create: %w", err)
		}
		inspected, inspectErr := c.cli.NetworkInspect(ctx, probe.ID, client.NetworkInspectOptions{})
		removeErr := func() error {
			_, err := c.cli.NetworkRemove(ctx, probe.ID, client.NetworkRemoveOptions{})
			return err
		}()
		if inspectErr != nil {
			return "", "", fmt.Errorf("network address probe inspect: %w", inspectErr)
		}
		if removeErr != nil {
			return "", "", fmt.Errorf("network address probe remove: %w", removeErr)
		}
		for _, cfg := range inspected.Network.IPAM.Config {
			if cfg.Subnet.IsValid() && cfg.Subnet.Addr().Is4() {
				subnet = cfg.Subnet.String()
				if gatewayAddr == "" && cfg.Gateway.IsValid() && cfg.Gateway.Is4() {
					gatewayAddr = cfg.Gateway.String()
				}
				break
			}
		}
		if subnet == "" {
			return "", "", errors.New("Docker did not allocate an IPv4 subnet for the managed database network")
		}
	}

	ipamCfg, reservedAddress, err := managedConnectorIPAM(subnet, gatewayAddr)
	if err != nil {
		return "", "", err
	}
	result, err := c.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{
		Driver: driver,
		IPAM: &network.IPAM{
			Config: []network.IPAMConfig{ipamCfg},
		},
	})
	if err != nil {
		return "", "", fmt.Errorf("reserved network create: %w", err)
	}
	return result.ID, reservedAddress, nil
}

func managedConnectorIPAM(subnet string, gatewayAddr string) (network.IPAMConfig, string, error) {
	prefix, err := netip.ParsePrefix(subnet)
	if err != nil || !prefix.Addr().Is4() {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q is not valid IPv4", subnet)
	}
	prefix = prefix.Masked()
	if prefix.Bits() > 28 {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q is too small", subnet)
	}

	baseBytes := prefix.Addr().As4()
	base := binary.BigEndian.Uint32(baseBytes[:])
	gateway := base + 1
	if gatewayAddr != "" {
		parsedGateway, parseErr := netip.ParseAddr(gatewayAddr)
		if parseErr != nil || !parsedGateway.Is4() || !prefix.Contains(parsedGateway) {
			return network.IPAMConfig{}, "", fmt.Errorf("managed database network gateway %q is invalid", gatewayAddr)
		}
		gatewayBytes := parsedGateway.As4()
		gateway = binary.BigEndian.Uint32(gatewayBytes[:])
	}

	reserved := base + 2
	if reserved == gateway {
		reserved++
	}
	var reservedBytes [4]byte
	binary.BigEndian.PutUint32(reservedBytes[:], reserved)
	reservedAddress := netip.AddrFrom4(reservedBytes)
	if !prefix.Contains(reservedAddress) {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q has no connector address", subnet)
	}

	dynamicBits := prefix.Bits() + 1
	halfSize := uint32(1) << uint32(32-dynamicBits)
	dynamicBase := base
	firstHalf := netip.PrefixFrom(prefix.Addr(), dynamicBits)
	if firstHalf.Contains(reservedAddress) {
		dynamicBase += halfSize
	}
	var dynamicBytes [4]byte
	binary.BigEndian.PutUint32(dynamicBytes[:], dynamicBase)
	dynamicRange := netip.PrefixFrom(netip.AddrFrom4(dynamicBytes), dynamicBits)

	var gatewayBytes [4]byte
	binary.BigEndian.PutUint32(gatewayBytes[:], gateway)
	return network.IPAMConfig{
		Subnet:  prefix,
		Gateway: netip.AddrFrom4(gatewayBytes),
		IPRange: dynamicRange,
	}, reservedAddress.String(), nil
}

// RemoveNetwork removes a network by ID.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	_, err := c.cli.NetworkRemove(ctx, id, client.NetworkRemoveOptions{})
	if err != nil {
		return fmt.Errorf("network remove: %w", err)
	}
	return nil
}

// ConnectContainerToNetwork connects a container to a network.
func (c *Client) ConnectContainerToNetwork(ctx context.Context, networkID, containerID string) error {
	_, err := c.cli.NetworkConnect(ctx, networkID, client.NetworkConnectOptions{
		Container: containerID,
	})
	if err != nil {
		return fmt.Errorf("network connect: %w", err)
	}
	return nil
}

// DisconnectContainerFromNetwork disconnects a container from a network.
func (c *Client) DisconnectContainerFromNetwork(ctx context.Context, networkID, containerID string) error {
	_, err := c.cli.NetworkDisconnect(ctx, networkID, client.NetworkDisconnectOptions{
		Container: containerID,
	})
	if err != nil {
		return fmt.Errorf("network disconnect: %w", err)
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────

// ContainerName returns the canonical name of a container (without leading "/").
