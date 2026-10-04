package docker

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// The anchor holds the connector's network namespace: its endpoints on the management network and on every link
// and target network, with their addresses (base+2 on link networks of the pool) and aliases. The connector
// containers run in it (network_mode container:<anchor>), so a new connector image starts next to the serving one on
// the same addresses: it binds the egress listeners with SO_REUSEPORT, the previous one stops accepting and drains,
// and no address or alias ever moves (F3). The anchor runs the connector image in its pause mode; it is replaced only
// when it is missing or its own small shape changes, never for another connector image.
const (
	secureLinkAnchorName      = "gateway-secure-link-anchor"
	secureLinkRoleLabel       = "wiolett.gateway.secure-link.role"
	secureLinkAnchorRole      = "anchor"
	secureLinkAnchorMemory    = 32 * 1024 * 1024
	secureLinkAnchorPidsLimit = int64(16)
)

var secureLinkAnchorCommand = []string{"pause"}

// ensureAnchor returns the running anchor, created (with image) or started when needed.
func (m *dockerSecureLinkManager) ensureAnchor(ctx context.Context, image string) (*container.InspectResponse, error) {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	switch {
	case err == nil && validSecureLinkAnchor(inspected.Container):
		if inspected.Container.State != nil && inspected.Container.State.Running {
			m.anchorID = inspected.Container.ID
			return &inspected.Container, nil
		}
		if _, err := m.plugin.client.cli.ContainerStart(ctx, inspected.Container.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return nil, fmt.Errorf("start secure-link anchor: %w", err)
		}
	case err == nil:
		if !ownedSecureLinkConnector(inspected.Container) {
			return nil, errors.New("refusing to replace a non-managed container using the secure-link anchor name")
		}
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspected.Container.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return nil, fmt.Errorf("replace outdated secure-link anchor: %w", err)
		}
		if err := m.createAnchor(ctx, image); err != nil {
			return nil, err
		}
	case isNotFoundErr(err):
		if err := m.createAnchor(ctx, image); err != nil {
			return nil, err
		}
	default:
		return nil, secureLinkConnectorUnchangedError{fmt.Errorf("inspect secure-link anchor: %w", err)}
	}
	inspected, err = m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	m.anchorID = inspected.Container.ID
	return &inspected.Container, nil
}

func (m *dockerSecureLinkManager) createAnchor(ctx context.Context, image string) error {
	if image != developmentSecureLinkImage {
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return fmt.Errorf("ensure secure-link connector image: %w", err)
		}
	}
	pids := secureLinkAnchorPidsLimit
	created, err := m.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: "65532:65532", Cmd: secureLinkAnchorCommand,
			// The connector's label keeps it among Gateway's internal containers.
			Labels: map[string]string{"wiolett.gateway.managed": "secure-link-connector", secureLinkRoleLabel: secureLinkAnchorRole},
		},
		HostConfig: &container.HostConfig{
			ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			Resources:     container.Resources{Memory: secureLinkAnchorMemory, PidsLimit: &pids},
		},
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{secureLinkManagementNetwork: {}}},
		Name:             secureLinkAnchorName,
	})
	if err != nil {
		return fmt.Errorf("create secure-link anchor: %w", err)
	}
	if _, err := m.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start secure-link anchor: %w", err)
	}
	return nil
}

// validSecureLinkAnchor checks the anchor's own shape. The image is any allowed connector image: a connector image
// change leaves the anchor as it is.
func validSecureLinkAnchor(inspect container.InspectResponse) bool {
	config, host := inspect.Config, inspect.HostConfig
	if strings.TrimPrefix(inspect.Name, "/") != secureLinkAnchorName || config == nil || host == nil {
		return false
	}
	return allowedSecureLinkConnectorImage(config.Image) && config.User == "65532:65532" &&
		slices.Equal([]string(config.Cmd), secureLinkAnchorCommand) &&
		config.Labels["wiolett.gateway.managed"] == "secure-link-connector" && config.Labels[secureLinkRoleLabel] == secureLinkAnchorRole &&
		len(config.ExposedPorts) == 0 && !host.Privileged && !host.PublishAllPorts && host.ReadonlyRootfs &&
		len(host.CapAdd) == 0 && containsFold(host.CapDrop, "ALL") && len(host.Binds) == 0 && len(host.Mounts) == 0 &&
		len(host.PortBindings) == 0 && string(host.NetworkMode) != "host" && host.RestartPolicy.Name == "unless-stopped" &&
		host.Resources.Memory == secureLinkAnchorMemory && host.Resources.PidsLimit != nil && *host.Resources.PidsLimit == secureLinkAnchorPidsLimit &&
		(containsFold(host.SecurityOpt, "no-new-privileges") || containsFold(host.SecurityOpt, "no-new-privileges:true"))
}

// isSecureLinkAnchor reports the anchor among the containers named like the connector's.
func isSecureLinkAnchor(inspect container.InspectResponse) bool {
	return inspect.Config != nil && inspect.Config.Labels[secureLinkRoleLabel] == secureLinkAnchorRole
}

// inSecureLinkAnchor reports a connector running in the anchor's network namespace.
func inSecureLinkAnchor(inspect container.InspectResponse, anchorID string) bool {
	return anchorID != "" && inspect.HostConfig != nil && string(inspect.HostConfig.NetworkMode) == "container:"+anchorID
}

// joinedBeforeAnchorStart reports a connector that started before the anchor's last start: it holds the network
// namespace of the anchor's previous run and must be restarted to join the current one.
func joinedBeforeAnchorStart(connector, anchor container.InspectResponse) bool {
	if connector.State == nil || anchor.State == nil {
		return false
	}
	connectorStarted, err1 := time.Parse(time.RFC3339Nano, connector.State.StartedAt)
	anchorStarted, err2 := time.Parse(time.RFC3339Nano, anchor.State.StartedAt)
	return err1 == nil && err2 == nil && connectorStarted.Before(anchorStarted)
}

// removeAnchor removes the anchor (teardown: no link remains).
func (m *dockerSecureLinkManager) removeAnchor(ctx context.Context) error {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		m.anchorID = ""
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	if !ownedSecureLinkConnector(inspected.Container) {
		return errors.New("refusing to remove a non-managed container using the secure-link anchor name")
	}
	if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspected.Container.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("remove secure-link anchor: %w", err)
	}
	m.anchorID = ""
	return nil
}

// anchorNetworks returns the anchor's network endpoints.
func (m *dockerSecureLinkManager) anchorNetworks(ctx context.Context) (map[string]*network.EndpointSettings, error) {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.anchorID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	return connectorNetworksOf(inspected.Container.NetworkSettings), nil
}
