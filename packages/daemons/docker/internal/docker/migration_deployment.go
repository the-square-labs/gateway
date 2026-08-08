package docker

import (
	"context"
	"fmt"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func (c *Client) CreateDeploymentStopped(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	if payload.RouterImage == "" {
		payload.RouterImage = "nginx:alpine"
	}
	if payload.ActiveSlot == "" {
		payload.ActiveSlot = "blue"
	}
	if payload.DesiredConfig.Image == "" {
		return nil, fmt.Errorf("deployment image is required")
	}
	for _, slot := range []string{"blue", "green"} {
		config := payload.SlotConfigs[slot]
		if config.Image == "" {
			config = payload.DesiredConfig
		}
		if err := c.pullImageIfNeeded(ctx, config.Image, payload.RegistryAuthJSON); err != nil {
			return nil, err
		}
	}
	if err := c.pullImageIfNeeded(ctx, payload.RouterImage, ""); err != nil {
		return nil, err
	}
	if err := c.ensureDeploymentNetwork(ctx, payload.NetworkName, payload.DeploymentID); err != nil {
		return nil, err
	}
	slotIDs := map[string]string{}
	for _, slot := range []string{"blue", "green"} {
		name := payload.Slots[slot]
		if name == "" {
			return nil, fmt.Errorf("%s slot container name is required", slot)
		}
		config := payload.SlotConfigs[slot]
		if config.Image == "" {
			config = payload.DesiredConfig
		}
		id, exists, err := c.existingMigrationDeploymentContainer(ctx, name, payload.DeploymentID, "app", slot)
		if err != nil {
			return nil, err
		}
		if !exists {
			gpuSelection, resolveErr := c.resolveGPUConfig(ctx, config.GPU)
			if resolveErr != nil {
				return nil, resolveErr
			}
			id, err = c.createDeploymentSlot(ctx, payload.DeploymentID, payload.NetworkName, slot, name, config, false, gpuSelection)
		}
		if err != nil {
			return nil, err
		}
		slotIDs[slot] = id
	}
	routerID, exists, err := c.existingMigrationDeploymentContainer(ctx, payload.RouterName, payload.DeploymentID, "router", "")
	if err != nil {
		return nil, err
	}
	if !exists {
		routerID, err = c.createStoppedDeploymentRouter(ctx, payload)
	}
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"routerId": routerID, "containerId": slotIDs[payload.ActiveSlot],
		"blueContainerId": slotIDs["blue"], "greenContainerId": slotIDs["green"],
	}, nil
}

func (c *Client) existingMigrationDeploymentContainer(
	ctx context.Context,
	name string,
	deploymentID string,
	role string,
	slot string,
) (string, bool, error) {
	existing, err := c.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", false, nil
	}
	if existing.Container.Config == nil {
		return "", false, fmt.Errorf("target deployment container %q has no configuration", name)
	}
	labels := existing.Container.Config.Labels
	if labels[deploymentIDLabel] != deploymentID || labels[deploymentRoleLabel] != role || (slot != "" && labels[deploymentSlotLabel] != slot) {
		return "", false, fmt.Errorf("target deployment container name %q is already in use", name)
	}
	return existing.Container.ID, true, nil
}

func (c *Client) createStoppedDeploymentRouter(ctx context.Context, payload deploymentCommandPayload) (string, error) {
	labels := map[string]string{
		deploymentManagedLabel: "true", deploymentIDLabel: payload.DeploymentID, deploymentRoleLabel: "router",
	}
	exposedPorts := make(network.PortSet)
	portBindings := make(network.PortMap)
	for _, route := range payload.Routes {
		port, err := network.ParsePort(fmt.Sprintf("%d/tcp", route.HostPort))
		if err != nil {
			return "", fmt.Errorf("parse router port: %w", err)
		}
		exposedPorts[port] = struct{}{}
		portBindings[port] = []network.PortBinding{{HostPort: fmt.Sprintf("%d", route.HostPort)}}
	}
	config := renderDeploymentNginx(payload.Routes, payload.ActiveSlot)
	cmd := []string{"sh", "-c", "cat > /etc/nginx/conf.d/default.conf <<'EOF'\n" + config + "\nEOF\nnginx -g 'daemon off;'"}
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:           &container.Config{Image: payload.RouterImage, Cmd: cmd, Labels: labels, ExposedPorts: exposedPorts},
		HostConfig:       &container.HostConfig{NetworkMode: container.NetworkMode(payload.NetworkName), PortBindings: portBindings},
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{payload.NetworkName: {}}},
		Name:             payload.RouterName,
	})
	if err != nil {
		return "", fmt.Errorf("create stopped deployment router: %w", err)
	}
	return resp.ID, nil
}
