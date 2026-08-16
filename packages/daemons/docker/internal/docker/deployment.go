package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	deploymentManagedLabel = "wiolett.gateway.deployment.managed"
	deploymentIDLabel      = "wiolett.gateway.deployment.id"
	deploymentRoleLabel    = "wiolett.gateway.deployment.role"
	deploymentSlotLabel    = "wiolett.gateway.deployment.slot"
)

type deploymentRouteConfig struct {
	HostPort      uint16 `json:"hostPort"`
	ContainerPort uint16 `json:"containerPort"`
	IsPrimary     bool   `json:"isPrimary"`
}

type deploymentHealthConfig struct {
	Path                 string `json:"path"`
	StatusMin            int    `json:"statusMin"`
	StatusMax            int    `json:"statusMax"`
	TimeoutSeconds       int    `json:"timeoutSeconds"`
	IntervalSeconds      int    `json:"intervalSeconds"`
	SuccessThreshold     int    `json:"successThreshold"`
	StartupGraceSeconds  int    `json:"startupGraceSeconds"`
	DeployTimeoutSeconds int    `json:"deployTimeoutSeconds"`
}

type deploymentDesiredConfig struct {
	Image          string            `json:"image"`
	Env            map[string]string `json:"env"`
	Mounts         []deploymentMount `json:"mounts"`
	Command        []string          `json:"command"`
	Entrypoint     []string          `json:"entrypoint"`
	WorkingDir     string            `json:"workingDir"`
	User           string            `json:"user"`
	Labels         map[string]string `json:"labels"`
	Networks       []string          `json:"networks"`
	RestartPolicy  string            `json:"restartPolicy"`
	RuntimeProfile string            `json:"runtimeProfile"`
	Runtime        map[string]any    `json:"runtime"`
	GPU            *GPUConfig        `json:"gpu"`
}

type deploymentMount struct {
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
	Name          string `json:"name"`
	ReadOnly      bool   `json:"readOnly"`
}

type deploymentSnapshot struct {
	ID            string                  `json:"id"`
	RouterName    string                  `json:"routerName"`
	RouterImage   string                  `json:"routerImage"`
	NetworkName   string                  `json:"networkName"`
	ActiveSlot    string                  `json:"activeSlot"`
	Routes        []deploymentRouteConfig `json:"routes"`
	HealthConfig  deploymentHealthConfig  `json:"healthConfig"`
	DesiredConfig deploymentDesiredConfig `json:"desiredConfig"`
	Slots         []struct {
		Slot          string `json:"slot"`
		ContainerName string `json:"containerName"`
	} `json:"slots"`
}

type deploymentCommandPayload struct {
	DeploymentID     string                             `json:"deploymentId"`
	Name             string                             `json:"name"`
	ActiveSlot       string                             `json:"activeSlot"`
	RouterName       string                             `json:"routerName"`
	RouterImage      string                             `json:"routerImage"`
	NetworkName      string                             `json:"networkName"`
	Slots            map[string]string                  `json:"slots"`
	Routes           []deploymentRouteConfig            `json:"routes"`
	Health           deploymentHealthConfig             `json:"health"`
	DesiredConfig    deploymentDesiredConfig            `json:"desiredConfig"`
	SlotConfigs      map[string]deploymentDesiredConfig `json:"slotConfigs"`
	Labels           map[string]string                  `json:"labels"`
	Deployment       deploymentSnapshot                 `json:"deployment"`
	ToSlot           string                             `json:"toSlot"`
	Slot             string                             `json:"slot"`
	Image            string                             `json:"image"`
	RegistryAuthJSON string                             `json:"registryAuthJson"`
	Force            bool                               `json:"force"`
}

func (p *DockerPlugin) handleDeploymentCommand(cmd *pb.DockerDeploymentCommand, result *pb.CommandResult) {
	ctx := context.Background()
	if cmd.ConfigJson == "" && cmd.Action != "inspect" {
		result.Success = false
		result.Error = "config_json is required"
		return
	}

	var payload deploymentCommandPayload
	if cmd.ConfigJson != "" {
		if err := json.Unmarshal([]byte(cmd.ConfigJson), &payload); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse deployment payload: %v", err)
			return
		}
	}
	if payload.DeploymentID == "" {
		payload.DeploymentID = cmd.DeploymentId
	}
	if payload.Slot == "" {
		payload.Slot = cmd.Slot
	}
	if cmd.Force {
		payload.Force = true
	}

	var detail any
	var err error
	switch cmd.Action {
	case "create":
		detail, err = p.client.CreateDeployment(ctx, payload)
	case "deploy_slot":
		detail, err = p.client.DeployDeploymentSlot(ctx, payload)
	case "switch":
		detail, err = p.client.SwitchDeployment(ctx, payload)
	case "update_router":
		detail, err = p.client.UpdateDeploymentRouter(ctx, payload)
	case "start":
		detail, err = p.client.StartDeployment(ctx, payload)
	case "stop":
		err = p.client.StopDeployment(ctx, payload)
	case "restart":
		detail, err = p.client.RestartDeployment(ctx, payload)
	case "kill":
		err = p.client.KillDeployment(ctx, payload)
	case "inspect":
		detail, err = p.client.InspectDeployment(ctx, cmd.DeploymentId)
	case "stop_slot":
		err = p.client.StopDeploymentSlot(ctx, payload)
	case "remove":
		err = p.client.RemoveDeployment(ctx, payload)
	default:
		err = fmt.Errorf("unknown deployment action: %s", cmd.Action)
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	if detail != nil {
		data, marshalErr := json.Marshal(detail)
		if marshalErr != nil {
			result.Success = false
			result.Error = marshalErr.Error()
			return
		}
		result.Detail = string(data)
	}
}

func (c *Client) CreateDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	if payload.RouterImage == "" {
		payload.RouterImage = "nginx:alpine"
	}
	if payload.ActiveSlot == "" {
		payload.ActiveSlot = "blue"
	}
	if payload.DesiredConfig.Image == "" {
		return nil, fmt.Errorf("deployment image is required")
	}
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
	if err := c.ensureDeploymentNetwork(ctx, payload.NetworkName, payload.DeploymentID); err != nil {
		return nil, err
	}

	slotIDs := map[string]string{}
	for _, slot := range []string{"blue", "green"} {
		slotName := payload.Slots[slot]
		if slotName == "" {
			return nil, fmt.Errorf("%s slot container name is required", slot)
		}
		slotID, err := c.createDeploymentSlot(ctx, payload.DeploymentID, payload.NetworkName, slot, slotName, payload.DesiredConfig, slot == payload.ActiveSlot, gpuSelection)
		if err != nil {
			return nil, err
		}
		slotIDs[slot] = slotID
	}
	routerID, err := c.createDeploymentRouter(ctx, payload, payload.ActiveSlot)
	if err != nil {
		return nil, err
	}
	slotName := payload.Slots[payload.ActiveSlot]
	if err := c.waitDeploymentReady(ctx, payload.NetworkName, slotName, payload.Routes, payload.Health); err != nil {
		return nil, err
	}
	return map[string]string{
		"routerId":         routerID,
		"containerId":      slotIDs[payload.ActiveSlot],
		"blueContainerId":  slotIDs["blue"],
		"greenContainerId": slotIDs["green"],
	}, nil
}

func (c *Client) DeployDeploymentSlot(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	slotName := dep.slotName(payload.ToSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", payload.ToSlot)
	}
	desired := payload.DesiredConfig
	if desired.Image == "" {
		desired = dep.DesiredConfig
		desired.Image = payload.Image
	}
	gpuSelection, err := c.resolveGPUConfig(ctx, desired.GPU)
	if err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, desired.Image, payload.RegistryAuthJSON); err != nil {
		return nil, err
	}
	_ = c.removeContainerByName(ctx, slotName, true)
	id, err := c.createDeploymentSlot(ctx, dep.ID, dep.NetworkName, payload.ToSlot, slotName, desired, true, gpuSelection)
	if err != nil {
		return nil, err
	}
	if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
		return nil, err
	}
	return map[string]string{"containerId": id}, nil
}

func (c *Client) SwitchDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	activeSlot := payload.ActiveSlot
	if activeSlot == "" {
		activeSlot = payload.Slot
	}
	if activeSlot == "" {
		return nil, fmt.Errorf("active slot is required")
	}
	slotName := dep.slotName(activeSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", activeSlot)
	}
	containerID := ""
	if payload.DesiredConfig.Image != "" {
		gpuSelection, err := c.resolveGPUConfig(ctx, payload.DesiredConfig.GPU)
		if err != nil {
			return nil, err
		}
		if err := c.pullImageIfNeeded(ctx, payload.DesiredConfig.Image, payload.RegistryAuthJSON); err != nil {
			return nil, err
		}
		_ = c.removeContainerByName(ctx, slotName, true)
		id, err := c.createDeploymentSlot(ctx, dep.ID, dep.NetworkName, activeSlot, slotName, payload.DesiredConfig, true, gpuSelection)
		if err != nil {
			return nil, err
		}
		containerID = id
	} else {
		id, err := c.ensureDeploymentSlotRunning(ctx, slotName)
		if err != nil {
			return nil, err
		}
		containerID = id
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, err
		}
	}
	config := renderDeploymentNginx(dep.Routes, activeSlot)
	if err := c.writeRouterConfig(ctx, dep.RouterName, config); err != nil {
		return nil, err
	}
	return map[string]string{"containerId": containerID}, nil
}

func (c *Client) UpdateDeploymentRouter(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	routes := payload.Routes
	if len(routes) == 0 {
		routes = dep.Routes
	}
	if len(routes) == 0 {
		return nil, fmt.Errorf("deployment routes are required")
	}
	if payload.DeploymentID == "" {
		payload.DeploymentID = dep.ID
	}
	if payload.RouterName == "" {
		payload.RouterName = dep.RouterName
	}
	if payload.RouterImage == "" {
		payload.RouterImage = dep.RouterImage
	}
	if payload.NetworkName == "" {
		payload.NetworkName = dep.NetworkName
	}
	payload.Routes = routes

	recreate, err := c.deploymentRouterNeedsRecreate(ctx, payload.RouterName, routes)
	if err != nil {
		return nil, err
	}
	if recreate {
		_ = c.removeContainerByName(ctx, payload.RouterName, true)
		routerID, err := c.createDeploymentRouter(ctx, payload, dep.ActiveSlot)
		if err != nil {
			if killErr := c.KillDeployment(ctx, payload); killErr != nil {
				return nil, fmt.Errorf("%w; deployment kill after router failure failed: %v", err, killErr)
			}
			return nil, fmt.Errorf("%w; deployment killed after router failure", err)
		}
		return map[string]string{"routerId": routerID}, nil
	}
	if err := c.writeRouterConfig(ctx, payload.RouterName, renderDeploymentNginx(routes, dep.ActiveSlot)); err != nil {
		if killErr := c.KillDeployment(ctx, payload); killErr != nil {
			return nil, fmt.Errorf("%w; deployment kill after router failure failed: %v", err, killErr)
		}
		return nil, fmt.Errorf("%w; deployment killed after router failure", err)
	}
	return map[string]string{}, nil
}

func (c *Client) StopDeploymentSlot(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	slot := payload.Slot
	if slot == "" {
		slot = payload.ToSlot
	}
	name := dep.slotName(slot)
	if name == "" {
		return fmt.Errorf("unknown deployment slot %q", slot)
	}
	timeout := 10
	err := c.StopContainer(ctx, name, timeout)
	if isNotFoundErr(err) {
		return nil
	}
	return err
}

func (c *Client) StartDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	slotName := dep.slotName(dep.ActiveSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", dep.ActiveSlot)
	}
	if err := c.stopInactiveDeploymentSlots(ctx, dep); err != nil {
		return nil, err
	}
	containerID, err := c.ensureDeploymentSlotRunning(ctx, slotName)
	if err != nil {
		return nil, err
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, err
		}
	}
	if _, err := c.ensureDeploymentContainerRunning(ctx, dep.RouterName); err != nil {
		return nil, err
	}
	if err := c.writeRouterConfig(ctx, dep.RouterName, renderDeploymentNginx(dep.Routes, dep.ActiveSlot)); err != nil {
		return nil, err
	}
	return map[string]string{"containerId": containerID}, nil
}

func (c *Client) StopDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	if err := c.StopContainer(ctx, dep.RouterName, 10); err != nil && !isNotFoundErr(err) {
		return err
	}
	for _, slot := range dep.Slots {
		if slot.ContainerName == "" {
			continue
		}
		if err := c.StopContainer(ctx, slot.ContainerName, 10); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) RestartDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	slotName := dep.slotName(dep.ActiveSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", dep.ActiveSlot)
	}
	if err := c.stopInactiveDeploymentSlots(ctx, dep); err != nil {
		return nil, err
	}
	if err := c.RestartContainer(ctx, slotName, 10); err != nil {
		return nil, err
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, err
		}
	}
	routerID, err := c.ensureDeploymentContainerRunning(ctx, dep.RouterName)
	if err != nil {
		return nil, err
	}
	if err := c.writeRouterConfig(ctx, dep.RouterName, renderDeploymentNginx(dep.Routes, dep.ActiveSlot)); err != nil {
		return nil, err
	}
	slotID, err := c.containerID(ctx, slotName)
	if err != nil {
		return nil, err
	}
	return map[string]string{"containerId": slotID, "routerId": routerID}, nil
}

func (c *Client) KillDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	if err := c.KillContainer(ctx, dep.RouterName, "SIGKILL"); err != nil && !isNotFoundErr(err) {
		return err
	}
	for _, slot := range dep.Slots {
		if slot.ContainerName == "" {
			continue
		}
		if err := c.KillContainer(ctx, slot.ContainerName, "SIGKILL"); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) stopInactiveDeploymentSlots(ctx context.Context, dep deploymentSnapshot) error {
	for _, slot := range dep.Slots {
		if slot.Slot == dep.ActiveSlot || slot.ContainerName == "" {
			continue
		}
		if err := c.StopContainer(ctx, slot.ContainerName, 10); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) RemoveDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	for _, slot := range []string{"blue", "green"} {
		if name := dep.slotName(slot); name != "" {
			_ = c.removeContainerByName(ctx, name, true)
		}
	}
	_ = c.removeContainerByName(ctx, dep.RouterName, true)
	if dep.NetworkName != "" {
		err := c.RemoveNetwork(ctx, dep.NetworkName)
		if err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) InspectDeployment(ctx context.Context, deploymentID string) (map[string]any, error) {
	result := map[string]any{"deploymentId": deploymentID, "containers": []ContainerInfo{}}
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	var matched []ContainerInfo
	for _, ctr := range containers {
		if ctr.Labels[deploymentIDLabel] == deploymentID {
			matched = append(matched, ctr)
		}
	}
	result["containers"] = matched
	return result, nil
}

func (c *Client) ensureDeploymentNetwork(ctx context.Context, name string, deploymentID string) error {
	if name == "" {
		return fmt.Errorf("network name is required")
	}
	_, err := c.cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
		Driver: "bridge",
		Labels: map[string]string{
			deploymentManagedLabel: "true",
			deploymentIDLabel:      deploymentID,
		},
	})
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return fmt.Errorf("create deployment network: %w", err)
	}
	return nil
}

func (c *Client) createDeploymentSlot(ctx context.Context, deploymentID, networkName, slot, name string, desired deploymentDesiredConfig, start bool, gpuSelection *gpuSelection) (string, error) {
	if name == "" {
		return "", fmt.Errorf("slot container name is required")
	}
	labels := map[string]string{}
	for k, v := range desired.Labels {
		labels[k] = v
	}
	labels[deploymentManagedLabel] = "true"
	labels[deploymentIDLabel] = deploymentID
	labels[deploymentRoleLabel] = "app"
	labels[deploymentSlotLabel] = slot

	cfg := &container.Config{
		Image:      desired.Image,
		Env:        envMapToList(desired.Env),
		Cmd:        desired.Command,
		Entrypoint: desired.Entrypoint,
		WorkingDir: desired.WorkingDir,
		User:       desired.User,
		Labels:     labels,
	}
	hostCfg := &container.HostConfig{
		Binds:       deploymentBinds(desired.Mounts),
		NetworkMode: container.NetworkMode(networkName),
	}
	applyUserWorkloadBaseline(hostCfg)
	if err := c.applyRuntimeProfile(hostCfg, desired.RuntimeProfile, desired.GPU); err != nil {
		return "", err
	}
	if desired.RestartPolicy != "" {
		hostCfg.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(desired.RestartPolicy)}
	}
	applyDeploymentRuntime(hostCfg, desired)
	c.applyResolvedGPUSelection(cfg, hostCfg, gpuSelection)
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     cfg,
		HostConfig: hostCfg,
		NetworkingConfig: &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				networkName: {Aliases: []string{slot}},
			},
		},
		Name: name,
	})
	if err != nil {
		return "", fmt.Errorf("create deployment slot: %w", err)
	}
	for _, additionalNetwork := range desired.Networks {
		if additionalNetwork == "" || additionalNetwork == networkName {
			continue
		}
		if _, err := c.cli.NetworkConnect(ctx, additionalNetwork, mobyclient.NetworkConnectOptions{Container: resp.ID}); err != nil {
			_ = c.RemoveContainer(ctx, resp.ID, true)
			return "", fmt.Errorf("connect deployment slot to managed network: %w", err)
		}
	}
	if start {
		if _, err := c.cli.ContainerStart(ctx, resp.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return "", fmt.Errorf("start deployment slot: %w", err)
		}
	}
	return resp.ID, nil
}

func applyDeploymentRuntime(hostCfg *container.HostConfig, desired deploymentDesiredConfig) {
	runtime := desired.Runtime
	restartPolicy := desired.RestartPolicy
	if value, ok := runtimeString(runtime, "restartPolicy"); ok {
		restartPolicy = value
	}
	if restartPolicy != "" {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(restartPolicy)}
		if restartPolicy == "on-failure" {
			if maxRetries, ok := runtimeInt(runtime, "maxRetries"); ok {
				policy.MaximumRetryCount = maxRetries
			}
		}
		hostCfg.RestartPolicy = policy
	}

	if memoryLimit, ok := runtimeInt64(runtime, "memoryLimit"); ok {
		hostCfg.Memory = memoryLimit
	} else if memoryMB, ok := runtimeFloat(runtime, "memoryMB"); ok {
		hostCfg.Memory = int64(math.Round(memoryMB * 1048576))
	}

	if memorySwap, ok := runtimeInt64(runtime, "memorySwap"); ok {
		hostCfg.MemorySwap = memorySwap
	} else if memSwapMB, ok := runtimeFloat(runtime, "memSwapMB"); ok {
		if memSwapMB == -1 {
			hostCfg.MemorySwap = -1
		} else if hostCfg.Memory > 0 {
			hostCfg.MemorySwap = hostCfg.Memory + int64(math.Round(math.Max(0, memSwapMB)*1048576))
		} else {
			hostCfg.MemorySwap = 0
		}
	}

	if nanoCPUs, ok := runtimeInt64(runtime, "nanoCPUs"); ok {
		applyNanoCPULimit(&hostCfg.Resources, nanoCPUs)
	} else if cpuCount, ok := runtimeFloat(runtime, "cpuCount"); ok {
		applyNanoCPULimit(&hostCfg.Resources, int64(math.Round(cpuCount*1e9)))
	}

	if cpuShares, ok := runtimeInt64(runtime, "cpuShares"); ok {
		hostCfg.CPUShares = cpuShares
	}

	if pidsLimit, ok := runtimeInt64(runtime, "pidsLimit"); ok {
		hostCfg.PidsLimit = &pidsLimit
	}
}

func runtimeString(runtime map[string]any, key string) (string, bool) {
	if runtime == nil {
		return "", false
	}
	value, ok := runtime[key]
	if !ok || value == nil {
		return "", false
	}
	switch typed := value.(type) {
	case string:
		if typed == "" {
			return "", false
		}
		return typed, true
	default:
		return fmt.Sprint(typed), true
	}
}

func runtimeFloat(runtime map[string]any, key string) (float64, bool) {
	if runtime == nil {
		return 0, false
	}
	value, ok := runtime[key]
	if !ok || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		if strings.TrimSpace(typed) == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(typed, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func runtimeInt(runtime map[string]any, key string) (int, bool) {
	value, ok := runtimeFloat(runtime, key)
	if !ok {
		return 0, false
	}
	return int(math.Round(value)), true
}

func runtimeInt64(runtime map[string]any, key string) (int64, bool) {
	value, ok := runtimeFloat(runtime, key)
	if !ok {
		return 0, false
	}
	return int64(math.Round(value)), true
}

func (c *Client) createDeploymentRouter(ctx context.Context, payload deploymentCommandPayload, activeSlot string) (string, error) {
	labels := map[string]string{
		deploymentManagedLabel: "true",
		deploymentIDLabel:      payload.DeploymentID,
		deploymentRoleLabel:    "router",
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
	config := renderDeploymentNginx(payload.Routes, activeSlot)
	cmd := []string{"sh", "-c", "cat > /etc/nginx/conf.d/default.conf <<'EOF'\n" + config + "\nEOF\nnginx -g 'daemon off;'"}
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image:        payload.RouterImage,
			Cmd:          cmd,
			Labels:       labels,
			ExposedPorts: exposedPorts,
		},
		HostConfig: &container.HostConfig{
			NetworkMode:  container.NetworkMode(payload.NetworkName),
			PortBindings: portBindings,
			SecurityOpt:  []string{"no-new-privileges:true"},
		},
		NetworkingConfig: &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{payload.NetworkName: {}},
		},
		Name: payload.RouterName,
	})
	if err != nil {
		return "", fmt.Errorf("create deployment router: %w", err)
	}
	if _, err := c.cli.ContainerStart(ctx, resp.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return "", fmt.Errorf("start deployment router: %w", err)
	}
	return resp.ID, nil
}

func (c *Client) deploymentRouterNeedsRecreate(ctx context.Context, routerName string, routes []deploymentRouteConfig) (bool, error) {
	if routerName == "" {
		return false, fmt.Errorf("router name is required")
	}
	inspect, err := c.cli.ContainerInspect(ctx, routerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return true, nil
		}
		return false, fmt.Errorf("inspect deployment router: %w", err)
	}
	actual := map[string]struct{}{}
	if inspect.Container.HostConfig != nil {
		for port := range inspect.Container.HostConfig.PortBindings {
			actual[port.String()] = struct{}{}
		}
	}
	desired := map[string]struct{}{}
	for _, route := range routes {
		desired[fmt.Sprintf("%d/tcp", route.HostPort)] = struct{}{}
	}
	if len(actual) != len(desired) {
		return true, nil
	}
	for port := range desired {
		if _, ok := actual[port]; !ok {
			return true, nil
		}
	}
	return false, nil
}

func (c *Client) writeRouterConfig(ctx context.Context, routerName string, config string) error {
	script := "cat > /etc/nginx/conf.d/default.conf <<'EOF'\n" + config + "\nEOF\nnginx -s reload"
	exec, err := c.cli.ExecCreate(ctx, routerName, mobyclient.ExecCreateOptions{
		AttachStdout: true,
		AttachStderr: true,
		Cmd:          []string{"sh", "-c", script},
	})
	if err != nil {
		return fmt.Errorf("create router reload exec: %w", err)
	}
	attach, err := c.cli.ExecAttach(ctx, exec.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return fmt.Errorf("reload router: %w", err)
	}
	raw, readErr := io.ReadAll(io.LimitReader(attach.Reader, 1024*1024))
	attach.Close()
	if readErr != nil {
		return fmt.Errorf("read router reload output: %w", readErr)
	}
	inspect, err := c.cli.ExecInspect(ctx, exec.ID, mobyclient.ExecInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect router reload exec: %w", err)
	}
	if inspect.ExitCode != 0 {
		output := strings.TrimSpace(string(raw))
		if output == "" {
			output = fmt.Sprintf("exit code %d", inspect.ExitCode)
		}
		return fmt.Errorf("reload router failed: %s", output)
	}
	return nil
}

func (c *Client) waitDeploymentReady(ctx context.Context, networkName, containerName string, routes []deploymentRouteConfig, health deploymentHealthConfig) error {
	primary := routes[0]
	for _, route := range routes {
		if route.IsPrimary {
			primary = route
			break
		}
	}
	if health.Path == "" {
		health.Path = "/"
	}
	if health.StatusMin == 0 {
		health.StatusMin = 200
	}
	if health.StatusMax == 0 {
		health.StatusMax = 399
	}
	if health.TimeoutSeconds <= 0 {
		health.TimeoutSeconds = 5
	}
	if health.IntervalSeconds <= 0 {
		health.IntervalSeconds = 5
	}
	if health.SuccessThreshold <= 0 {
		health.SuccessThreshold = 1
	}
	if health.DeployTimeoutSeconds <= 0 {
		health.DeployTimeoutSeconds = 300
	}
	if health.StartupGraceSeconds > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(health.StartupGraceSeconds) * time.Second):
		}
	}
	deadline := time.Now().Add(time.Duration(health.DeployTimeoutSeconds) * time.Second)
	successes := 0
	client := http.Client{Timeout: time.Duration(health.TimeoutSeconds) * time.Second}
	for time.Now().Before(deadline) {
		ip, err := c.containerIP(ctx, containerName, networkName)
		if err == nil && ip != "" {
			url := fmt.Sprintf("http://%s:%d%s", ip, primary.ContainerPort, health.Path)
			resp, reqErr := client.Get(url)
			if reqErr == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode >= health.StatusMin && resp.StatusCode <= health.StatusMax {
					successes++
					if successes >= health.SuccessThreshold {
						return nil
					}
				} else {
					successes = 0
				}
			} else {
				successes = 0
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(health.IntervalSeconds) * time.Second):
		}
	}
	return fmt.Errorf("deployment readiness timed out for %s", containerName)
}

func (c *Client) ensureDeploymentSlotRunning(ctx context.Context, containerName string) (string, error) {
	return c.ensureDeploymentContainerRunning(ctx, containerName)
}

func (c *Client) ensureDeploymentContainerRunning(ctx context.Context, containerName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect deployment container %s: %w", containerName, err)
	}
	if insp.Container.State != nil && insp.Container.State.Running {
		return insp.Container.ID, nil
	}
	if _, err := c.cli.ContainerStart(ctx, containerName, mobyclient.ContainerStartOptions{}); err != nil {
		return "", fmt.Errorf("start deployment container %s: %w", containerName, err)
	}
	return insp.Container.ID, nil
}

func (c *Client) containerID(ctx context.Context, containerName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	return insp.Container.ID, nil
}

func (c *Client) containerIP(ctx context.Context, containerName, networkName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	if endpoint := insp.Container.NetworkSettings.Networks[networkName]; endpoint != nil {
		if endpoint.IPAddress.IsValid() {
			return endpoint.IPAddress.String(), nil
		}
	}
	return "", fmt.Errorf("container %s is not attached to %s", containerName, networkName)
}

func (c *Client) pullImageIfNeeded(ctx context.Context, imageRef string, registryAuth string) error {
	if imageRef == "" {
		return nil
	}
	opts := mobyclient.ImagePullOptions{}
	if registryAuth != "" {
		opts.RegistryAuth = registryAuth
	}
	reader, err := c.cli.ImagePull(ctx, imageRef, opts)
	if err != nil {
		return fmt.Errorf("pull image %s: %w", imageRef, err)
	}
	_, _ = io.Copy(io.Discard, reader)
	return reader.Close()
}

func (c *Client) removeContainerByName(ctx context.Context, name string, force bool) error {
	if name == "" {
		return nil
	}
	err := c.RemoveContainer(ctx, name, force)
	if err != nil && !isNotFoundErr(err) {
		return err
	}
	return nil
}

func (d deploymentSnapshot) slotName(slot string) string {
	for _, candidate := range d.Slots {
		if candidate.Slot == slot {
			return candidate.ContainerName
		}
	}
	return ""
}

func envMapToList(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	items := make([]string, 0, len(env))
	for k, v := range env {
		items = append(items, k+"="+v)
	}
	return items
}

func deploymentBinds(mounts []deploymentMount) []string {
	var binds []string
	for _, mount := range mounts {
		source := mount.HostPath
		if source == "" {
			source = mount.Name
		}
		if source == "" || mount.ContainerPath == "" {
			continue
		}
		bind := source + ":" + mount.ContainerPath
		if mount.ReadOnly {
			bind += ":ro"
		}
		binds = append(binds, bind)
	}
	return binds
}

func renderDeploymentNginx(routes []deploymentRouteConfig, activeSlot string) string {
	var b strings.Builder
	b.WriteString("map $http_upgrade $connection_upgrade {\n  default upgrade;\n  '' close;\n}\n")
	for _, route := range routes {
		fmt.Fprintf(&b, "server {\n  listen %d;\n  location / {\n", route.HostPort)
		fmt.Fprintf(&b, "    proxy_pass http://%s:%d;\n", activeSlot, route.ContainerPort)
		b.WriteString("    proxy_http_version 1.1;\n")
		b.WriteString("    proxy_set_header Host $host;\n")
		b.WriteString("    proxy_set_header X-Real-IP $remote_addr;\n")
		b.WriteString("    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n")
		b.WriteString("    proxy_set_header X-Forwarded-Proto $scheme;\n")
		b.WriteString("    proxy_set_header Upgrade $http_upgrade;\n")
		b.WriteString("    proxy_set_header Connection $connection_upgrade;\n")
		b.WriteString("  }\n}\n")
	}
	return b.String()
}

func isNotFoundErr(err error) bool {
	if err == nil {
		return false
	}
	if cerrdefs.IsNotFound(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no such container") ||
		strings.Contains(msg, "no such network") ||
		strings.Contains(msg, "no such image") ||
		strings.Contains(msg, "not found")
}
