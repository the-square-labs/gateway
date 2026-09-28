package docker

import (
	"context"
	"errors"
	"fmt"
)

// Standby preparation for lease-mode Availability (D7, T6 §3.2): the image
// is pulled and the workload created, but never started. Only the lease
// holder starts it (A2.1). availability_lease_v2 implies these actions.

const (
	deploymentActionCreateStandby = "create_standby"
	composeActionPullCreate       = "pull_create"
)

var errStandbyOverRunningCopy = errors.New("a standby is never prepared over a running copy of the workload")

// CreateDeploymentStandby is create without starting the app: network,
// router and slot containers exist, images are pulled, the app slots keep
// RestartPolicy "no" and stay stopped. The router runs; it serves nothing
// until the lease holder starts the active slot.
func (c *Client) CreateDeploymentStandby(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	if payload.RouterImage == "" {
		payload.RouterImage = defaultDeploymentRouterImage
	}
	if payload.ActiveSlot == "" {
		payload.ActiveSlot = "blue"
	}
	if payload.DesiredConfig.Image == "" {
		return nil, fmt.Errorf("deployment image is required")
	}
	for _, slot := range []string{"blue", "green"} {
		if payload.Slots[slot] == "" {
			return nil, fmt.Errorf("%s slot container name is required", slot)
		}
	}
	running, err := c.deploymentAppRunning(ctx, payload.DeploymentID)
	if err != nil {
		return nil, err
	}
	if running {
		return nil, errStandbyOverRunningCopy
	}
	payload.DesiredConfig.RestartPolicy = "no"
	// runtime.restartPolicy overrides the top-level policy at create time.
	runtime := make(map[string]any, len(payload.DesiredConfig.Runtime)+1)
	for key, value := range payload.DesiredConfig.Runtime {
		runtime[key] = value
	}
	runtime["restartPolicy"] = "no"
	payload.DesiredConfig.Runtime = runtime
	gpuSelection, err := c.resolveGPUConfig(ctx, payload.DesiredConfig.GPU)
	if err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, payload.DesiredConfig.Image, payload.RegistryAuthJSON); err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, payload.RouterImage, ""); err != nil {
		return nil, err
	}
	if err := c.removeLeftoverDeploymentContainers(ctx, payload.DeploymentID, []string{payload.Slots["blue"], payload.Slots["green"], payload.RouterName}); err != nil {
		return nil, err
	}
	if err := c.ensureDeploymentNetwork(ctx, payload.NetworkName, payload.DeploymentID); err != nil {
		return nil, err
	}
	slotIDs := map[string]string{}
	for _, slot := range []string{"blue", "green"} {
		id, err := c.createDeploymentSlot(ctx, payload.DeploymentID, payload.NetworkName, slot, payload.Slots[slot], payload.DesiredConfig, false, gpuSelection)
		if err != nil {
			return nil, err
		}
		slotIDs[slot] = id
	}
	routerID, err := c.createDeploymentRouter(ctx, payload, payload.ActiveSlot)
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"routerId": routerID, "containerId": slotIDs[payload.ActiveSlot],
		"blueContainerId": slotIDs["blue"], "greenContainerId": slotIDs["green"], "activeSlot": payload.ActiveSlot,
	}, nil
}

func (c *Client) deploymentAppRunning(ctx context.Context, deploymentID string) (bool, error) {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return false, err
	}
	for _, ctr := range containers {
		if ctr.Labels[deploymentIDLabel] == deploymentID && ctr.Labels[deploymentRoleLabel] == "app" && ctr.State == "running" {
			return true, nil
		}
	}
	return false, nil
}

// composeProjectRunning refuses a standby pull_create over a running copy:
// compose create may recreate a changed service and stop it.
func (c *Client) composeProjectRunning(ctx context.Context, projectName string) (bool, error) {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return false, err
	}
	for _, ctr := range containers {
		if ctr.Labels[composeProjectLabel] == projectName && ctr.State == "running" {
			return true, nil
		}
	}
	return false, nil
}
