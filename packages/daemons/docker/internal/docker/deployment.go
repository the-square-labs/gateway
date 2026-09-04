package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	deploymentManagedLabel           = "wiolett.gateway.deployment.managed"
	deploymentIDLabel                = "wiolett.gateway.deployment.id"
	deploymentRoleLabel              = "wiolett.gateway.deployment.role"
	deploymentSlotLabel              = "wiolett.gateway.deployment.slot"
	availabilityPolicyLabel          = "wiolett.gateway.availability.policy"
	availabilityPlacementLabel       = "wiolett.gateway.availability.placement"
	availabilityGenerationLabel      = "wiolett.gateway.availability.generation"
	availabilitySpecFingerprintLabel = "wiolett.gateway.availability.spec-fingerprint"
)

type deploymentRouteConfig struct {
	HostPort      uint16 `json:"hostPort"`
	HostIP        string `json:"hostIp"`
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
	ExtraHosts     []string          `json:"extraHosts"`
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

type deploymentOperation struct {
	generation uint64
	cancel     context.CancelFunc
	done       chan struct{}
}

func (p *DockerPlugin) beginDeploymentOperation(deploymentID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	p.deploymentOpMu.Lock()
	p.deploymentOpSeq++
	generation := p.deploymentOpSeq
	done := make(chan struct{})
	p.deploymentOps[deploymentID] = deploymentOperation{generation: generation, cancel: cancel, done: done}
	p.deploymentOpMu.Unlock()
	return ctx, func() {
		cancel()
		p.deploymentOpMu.Lock()
		if current, ok := p.deploymentOps[deploymentID]; ok && current.generation == generation {
			delete(p.deploymentOps, deploymentID)
		}
		close(done)
		p.deploymentOpMu.Unlock()
	}
}

func (p *DockerPlugin) cancelDeploymentOperationAndWait(deploymentID string, timeout time.Duration) bool {
	p.deploymentOpMu.Lock()
	operation, ok := p.deploymentOps[deploymentID]
	p.deploymentOpMu.Unlock()
	if !ok {
		return true
	}
	operation.cancel()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-operation.done:
		return true
	case <-timer.C:
		return false
	}
}

func (p *DockerPlugin) handleDeploymentCommand(cmd *pb.DockerDeploymentCommand, result *pb.CommandResult) {
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

	ctx := context.Background()
	finishOperation := func() {}
	if cmd.Action == "kill" {
		if !p.cancelDeploymentOperationAndWait(payload.DeploymentID, emergencyKillCancellationTimeout) {
			result.Success = false
			result.Error = "timed out cancelling the active deployment operation"
			return
		}
	} else if cmd.Action != "inspect" {
		ctx, finishOperation = p.beginDeploymentOperation(payload.DeploymentID)
	}
	defer finishOperation()

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
		detail, err = p.client.InspectDeployment(ctx, cmd.DeploymentId, payload.Deployment)
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
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return err
	}
	byName := make(map[string]ContainerInfo, len(containers))
	for _, container := range containers {
		byName[container.Name] = container
	}
	targets := []struct {
		name string
		role string
		slot string
	}{
		{name: dep.slotName("blue"), role: "app", slot: "blue"},
		{name: dep.slotName("green"), role: "app", slot: "green"},
		{name: dep.RouterName, role: "router"},
	}
	for _, target := range targets {
		if target.name == "" {
			continue
		}
		container, exists := byName[target.name]
		if !exists {
			continue
		}
		if !deploymentRemovalContainerMatches(container, dep, target.role, target.slot, payload.Force) {
			return fmt.Errorf("deployment container %q ownership does not match removal payload", target.name)
		}
	}
	for _, target := range targets {
		if err := c.removeContainerByName(ctx, target.name, true); err != nil {
			return err
		}
	}
	if dep.NetworkName != "" {
		err = c.RemoveNetwork(ctx, dep.NetworkName)
		if err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) InspectDeployment(ctx context.Context, deploymentID string, expected deploymentSnapshot) (map[string]any, error) {
	result := map[string]any{"deploymentId": deploymentID, "containers": []ContainerInfo{}}
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	var matched []ContainerInfo
	expectedNames := map[string]struct{}{}
	if expected.RouterName != "" {
		expectedNames[expected.RouterName] = struct{}{}
	}
	for _, slot := range expected.Slots {
		if slot.ContainerName != "" {
			expectedNames[slot.ContainerName] = struct{}{}
		}
	}
	for _, ctr := range containers {
		_, exactNameMatch := expectedNames[ctr.Name]
		if ctr.Labels[deploymentIDLabel] == deploymentID || exactNameMatch {
			matched = append(matched, ctr)
		}
	}
	result["containers"] = matched
	return result, nil
}

func deploymentRemovalContainerMatches(container ContainerInfo, dep deploymentSnapshot, role, slot string, force bool) bool {
	labels := container.Labels
	if labels[deploymentIDLabel] != dep.ID || labels[deploymentManagedLabel] != "true" || labels[deploymentRoleLabel] != role {
		return false
	}
	if role == "app" && labels[deploymentSlotLabel] != slot {
		return false
	}
	if force {
		return true
	}
	expectedLabels := dep.DesiredConfig.Labels
	actualAvailability := []string{
		labels[availabilityPolicyLabel],
		labels[availabilityPlacementLabel],
		labels[availabilityGenerationLabel],
		labels[availabilitySpecFingerprintLabel],
	}
	hasAvailabilityIdentity := false
	for _, value := range actualAvailability {
		if value != "" {
			hasAvailabilityIdentity = true
			break
		}
	}
	if !hasAvailabilityIdentity {
		expectedImage := dep.RouterImage
		if role == "app" {
			expectedImage = dep.DesiredConfig.Image
		}
		return expectedImage == "" || container.Image == expectedImage
	}
	if role != "app" {
		return false
	}
	if expectedLabels[availabilityPolicyLabel] == "" && expectedLabels[availabilityPlacementLabel] == "" {
		return true
	}
	if expectedLabels[availabilityPolicyLabel] == "" || expectedLabels[availabilityPlacementLabel] == "" {
		return false
	}
	if labels[availabilityPolicyLabel] != expectedLabels[availabilityPolicyLabel] ||
		labels[availabilityPlacementLabel] != expectedLabels[availabilityPlacementLabel] {
		return false
	}
	actualGeneration, actualErr := strconv.ParseUint(labels[availabilityGenerationLabel], 10, 64)
	expectedGeneration, expectedErr := strconv.ParseUint(expectedLabels[availabilityGenerationLabel], 10, 64)
	return actualErr == nil && expectedErr == nil && actualGeneration > 0 && actualGeneration <= expectedGeneration
}
