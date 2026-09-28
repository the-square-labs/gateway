package docker

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// Router repair after a daemon start or a node reboot.
//
// A router created before routers restarted with the Docker engine, or set to
// restart policy "no" by a migration, stays exited after a node reboot while
// Docker brings the app slots back, and the deployment answers 502 until a
// deployment action recreates the router. The daemon repairs such routers on
// its own: at startup for every deployment on the node, and for a lease-mode
// policy right before its holder opens the endpoints (the router is not
// lease-governed, see leaseIntegration.ServeSet).
//
// Only a serving deployment gets its router back. A deployment serves while
// one of its app slots runs: stop and kill stop every slot, so a deliberately
// stopped deployment keeps its router stopped, and so does a lease standby
// whose slots only the lease holder starts. At startup Docker is the authority
// for a router with the restart policy: it brings every such router back
// unless it was stopped on purpose, so one that is down stays down (an app
// slot with restart policy "always" comes back even after a deployment stop).

const (
	deploymentRouterRepairStartupTimeout = 2 * time.Minute
	// A lease holder repairs right before opening its endpoints; an operation
	// on the deployment that holds the lock longer brings the router back
	// itself (start, restart and switch all ensure it).
	deploymentRouterRepairLeaseTimeout = 20 * time.Second
	deploymentRouterRepairLockWait     = 10 * time.Second
	deploymentRouterRollbackTimeout    = 30 * time.Second
	deploymentRouterStopTimeoutSeconds = 10
)

// deploymentRouterRepair is one router the repair changed.
type deploymentRouterRepair struct {
	DeploymentID string
	Router       string
	// Action is what was done: "restart policy", "started", "recreated".
	Action string
}

// deploymentRouterLock serializes a repair with the deployment's operations.
type deploymentRouterLock func(ctx context.Context, deploymentID string) (func(), error)

// deploymentRouterRepairScope selects the deployments a repair covers and
// what it may do to them.
type deploymentRouterRepairScope struct {
	// include narrows the deployments by their app containers (nil: all).
	include func(apps []ContainerInfo) bool
	// serving: this node explicitly serves the deployments (a lease holder
	// opening its endpoints), so a stopped router is started whatever its
	// restart policy. Otherwise a stopped router that Docker would have
	// brought back with the engine was stopped on purpose and stays stopped.
	serving bool
}

// deploymentMembers are the managed containers of one deployment.
type deploymentMembers struct {
	routers []ContainerInfo
	apps    []ContainerInfo
}

func groupDeploymentMembers(containers []ContainerInfo) map[string]*deploymentMembers {
	out := map[string]*deploymentMembers{}
	for _, ctr := range containers {
		deploymentID := ctr.Labels[deploymentIDLabel]
		if deploymentID == "" || ctr.Labels[deploymentManagedLabel] != "true" {
			continue
		}
		members := out[deploymentID]
		if members == nil {
			members = &deploymentMembers{}
			out[deploymentID] = members
		}
		switch ctr.Labels[deploymentRoleLabel] {
		case "router":
			members.routers = append(members.routers, ctr)
		case "app":
			members.apps = append(members.apps, ctr)
		}
	}
	return out
}

// serving reports whether one of the deployment's app slots runs.
func (m *deploymentMembers) serving() bool {
	for _, app := range m.apps {
		switch app.State {
		case "running", "restarting", "paused":
			return true
		}
	}
	return false
}

func (m *deploymentMembers) repairable(include func(apps []ContainerInfo) bool) bool {
	return m != nil && len(m.routers) > 0 && m.serving() && (include == nil || include(m.apps))
}

// repairServingDeploymentRouters makes the router of every serving deployment
// in scope run with the current shape. One deployment failing does not stop
// the others.
func (c *Client) repairServingDeploymentRouters(ctx context.Context, scope deploymentRouterRepairScope, lock deploymentRouterLock) ([]deploymentRouterRepair, error) {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	var deploymentIDs []string
	for deploymentID, members := range groupDeploymentMembers(containers) {
		if members.repairable(scope.include) {
			deploymentIDs = append(deploymentIDs, deploymentID)
		}
	}
	sort.Strings(deploymentIDs)
	var repairs []deploymentRouterRepair
	var errs []error
	for _, deploymentID := range deploymentIDs {
		repair, err := c.repairDeploymentRouter(ctx, deploymentID, scope, lock)
		if err != nil {
			errs = append(errs, fmt.Errorf("deployment %s: %w", deploymentID, err))
			continue
		}
		if repair.Action != "" {
			repairs = append(repairs, repair)
		}
	}
	return repairs, errors.Join(errs...)
}

func (c *Client) repairDeploymentRouter(ctx context.Context, deploymentID string, scope deploymentRouterRepairScope, lock deploymentRouterLock) (deploymentRouterRepair, error) {
	repair := deploymentRouterRepair{DeploymentID: deploymentID}
	if lock != nil {
		unlock, err := lock(ctx, deploymentID)
		if err != nil {
			return repair, fmt.Errorf("wait for the running deployment operation: %w", err)
		}
		defer unlock()
	}
	// An operation that held the lock may have stopped or removed the
	// deployment in the meantime.
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return repair, err
	}
	members := groupDeploymentMembers(containers)[deploymentID]
	if !members.repairable(scope.include) {
		return repair, nil
	}
	if len(members.routers) != 1 {
		return repair, fmt.Errorf("%d router containers carry the deployment labels", len(members.routers))
	}
	router := members.routers[0]
	repair.Router = router.Name
	inspect, err := c.cli.ContainerInspect(ctx, router.ID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return repair, nil
		}
		return repair, fmt.Errorf("inspect deployment router %s: %w", router.Name, err)
	}
	current := inspect.Container
	if current.Config == nil || current.HostConfig == nil {
		return repair, fmt.Errorf("deployment router %s has no configuration", router.Name)
	}
	running := current.State != nil && current.State.Running
	switch current.HostConfig.RestartPolicy.Name {
	case container.RestartPolicyUnlessStopped, container.RestartPolicyAlways:
		if !running && !scope.serving {
			// Docker restarts this router with the engine unless it was
			// stopped on purpose, by a deployment stop or kill.
			return repair, nil
		}
	}
	if !deploymentRouterCommandCurrent(current) {
		// An older daemon's router rewrites its creation-time config on every
		// start, which names the slot that was active back then: it is
		// recreated from the config it serves now.
		if err := c.replaceLegacyDeploymentRouter(ctx, current, deploymentID, running); err != nil {
			return repair, err
		}
		repair.Action = "recreated"
		return repair, nil
	}
	var actions []string
	if current.HostConfig.RestartPolicy.Name != deploymentRouterRestartPolicy {
		policy := container.RestartPolicy{Name: deploymentRouterRestartPolicy}
		if _, err := c.cli.ContainerUpdate(ctx, current.ID, mobyclient.ContainerUpdateOptions{RestartPolicy: &policy}); err != nil {
			return repair, fmt.Errorf("set the restart policy of deployment router %s: %w", router.Name, err)
		}
		actions = append(actions, "restart policy")
	}
	if !running {
		// The config on disk is the one last written; the start keeps it.
		if _, err := c.cli.ContainerStart(ctx, current.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return repair, fmt.Errorf("start deployment router %s: %w", router.Name, err)
		}
		actions = append(actions, "started")
	}
	upgraded, err := c.upgradeDeploymentRouterConfig(ctx, current)
	if upgraded {
		actions = append(actions, "config upgraded")
	}
	repair.Action = strings.Join(actions, ", ")
	if err != nil {
		return repair, err
	}
	return repair, nil
}

// upgradeDeploymentRouterConfig rewrites the config of a running router that
// still serves an older daemon's config (per-request slot resolution through
// dockerd's DNS, B-8), or a config naming another address than the active
// slot's current one, with the current config for the same slot and routes.
func (c *Client) upgradeDeploymentRouterConfig(ctx context.Context, current container.InspectResponse) (bool, error) {
	name := trimContainerName(current.Name)
	content, err := c.readContainerFile(ctx, current.ID, deploymentRouterConfigPath, deploymentRouterOutputLimit)
	if err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, fmt.Errorf("read the config of deployment router %s: %w", name, err)
	}
	config := string(content)
	var labels map[string]string
	if current.Config != nil {
		labels = current.Config.Labels
	}
	slot := deploymentRouterConfigSlot(config)
	address := ""
	if slot != "" && labels[deploymentIDLabel] != "" && current.HostConfig != nil {
		address = c.deploymentSlotAddress(ctx, labels[deploymentIDLabel], slot, string(current.HostConfig.NetworkMode))
	}
	if deploymentRouterConfigCurrent(config) && (address == "" || deploymentRouterConfigAddress(config) == address) {
		return false, nil
	}
	slot, routes, err := deploymentRouterConfigRoutes(config, current.HostConfig.PortBindings)
	if err != nil {
		return false, fmt.Errorf("deployment router %s serves a config that cannot be carried over: %w", name, err)
	}
	if err := c.writeRouterConfig(ctx, name, renderDeploymentNginxAt(routes, slot, address)); err != nil {
		return false, fmt.Errorf("upgrade the config of deployment router %s: %w", name, err)
	}
	return true, nil
}

// deploymentSlotAddress is the address of a deployment's running app slot on
// the router's network, or "" when no such slot runs or dockerd does not tell.
func (c *Client) deploymentSlotAddress(ctx context.Context, deploymentID, slot, networkName string) string {
	if networkName == "" {
		return ""
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	containers, err := c.ListContainers(lookupCtx)
	if err != nil {
		return ""
	}
	for _, ctr := range containers {
		if !deploymentContainerLabelsOwned(ctr.Labels, deploymentID) || ctr.Labels[deploymentRoleLabel] != "app" ||
			ctr.Labels[deploymentSlotLabel] != slot || ctr.State != "running" {
			continue
		}
		if ip, err := c.containerIP(lookupCtx, ctr.ID, networkName); err == nil {
			return ip
		}
	}
	return ""
}

// Router address reconciliation (B-8, D5). A router whose nginx lacks upstream
// re-resolution (before 1.27.3) proxies to the slot address rendered into its
// config, never asking dockerd's DNS; when the slot restarts with another
// address the config is rendered again. Routers with re-resolution follow the
// address themselves; their config is kept current the same way.
const (
	deploymentRouterAddressInterval = 5 * time.Second
	deploymentRouterAddressLockWait = time.Second
)

func (p *DockerPlugin) runDeploymentRouterAddresses(ctx context.Context) {
	ticker := time.NewTicker(deploymentRouterAddressInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		p.reconcileDeploymentRouterAddresses(ctx)
	}
}

// reconcileDeploymentRouterAddresses re-renders the config of every running
// router whose active slot now runs at another address than its config names.
// A deployment operation in progress keeps its lock; its router is checked on
// the next pass.
func (p *DockerPlugin) reconcileDeploymentRouterAddresses(ctx context.Context) {
	if p.client == nil {
		return
	}
	listCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	containers, err := p.client.ListContainers(listCtx)
	cancel()
	if err != nil {
		return
	}
	for deploymentID, members := range groupDeploymentMembers(containers) {
		if len(members.routers) != 1 || members.routers[0].State != "running" || !members.serving() {
			continue
		}
		func() {
			lockCtx, cancelLock := context.WithTimeout(ctx, deploymentRouterAddressLockWait)
			defer cancelLock()
			unlock, err := p.lockDeployment(lockCtx, deploymentID)
			if err != nil {
				return
			}
			defer unlock()
			inspectCtx, cancelInspect := context.WithTimeout(ctx, 10*time.Second)
			defer cancelInspect()
			inspect, err := p.client.cli.ContainerInspect(inspectCtx, members.routers[0].ID, mobyclient.ContainerInspectOptions{})
			if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.HostConfig == nil {
				return
			}
			upgraded, err := p.client.upgradeDeploymentRouterConfig(inspectCtx, inspect.Container)
			if err != nil {
				p.logger.Warn("deployment router address update failed; retried", "deployment_id", deploymentID, "error", err)
				return
			}
			if upgraded {
				p.logger.Info("deployment router follows its active slot's address", "deployment_id", deploymentID, "router", members.routers[0].Name)
			}
		}()
	}
}

// replaceLegacyDeploymentRouter recreates a router of an older daemon with
// the current shape, serving the slot and routes of the config it serves now.
// The old router is set aside, not removed, until its replacement runs, so a
// failed replacement puts it back as it was.
func (c *Client) replaceLegacyDeploymentRouter(ctx context.Context, current container.InspectResponse, deploymentID string, running bool) error {
	name := trimContainerName(current.Name)
	config, err := c.deploymentRouterServedConfig(ctx, current)
	if err != nil {
		return fmt.Errorf("router %s was created by an older daemon: %w", name, err)
	}
	slot, routes, err := deploymentRouterConfigRoutes(config, current.HostConfig.PortBindings)
	if err != nil {
		return fmt.Errorf("router %s was created by an older daemon and its config cannot be carried over: %w", name, err)
	}
	networkName := string(current.HostConfig.NetworkMode)
	if networkName == "" || current.Config.Image == "" {
		return fmt.Errorf("router %s was created by an older daemon and has no network or image", name)
	}
	payload := deploymentCommandPayload{
		DeploymentID: deploymentID,
		RouterName:   name,
		RouterImage:  current.Config.Image,
		NetworkName:  networkName,
		Routes:       routes,
	}
	if err := c.pullImageIfNeeded(ctx, payload.RouterImage, ""); err != nil {
		return err
	}
	// The replacement needs the published ports the old router holds.
	if running {
		if err := c.StopContainer(ctx, current.ID, deploymentRouterStopTimeoutSeconds); err != nil {
			return fmt.Errorf("stop deployment router %s: %w", name, err)
		}
	}
	aside := fmt.Sprintf("%s-replaced-%d", name, time.Now().UnixNano())
	if err := c.RenameContainer(ctx, current.ID, aside); err != nil {
		return c.restoreSetAsideRouter(ctx, current.ID, name, running, fmt.Errorf("set deployment router %s aside: %w", name, err), false)
	}
	if _, err := c.createDeploymentRouter(ctx, payload, slot); err != nil {
		return c.restoreSetAsideRouter(ctx, current.ID, name, running, err, true)
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deploymentRouterRollbackTimeout)
	defer cancel()
	if err := c.RemoveContainer(cleanupCtx, current.ID, true); err != nil {
		return fmt.Errorf("remove the replaced deployment router %s: %w", aside, err)
	}
	return nil
}

// restoreSetAsideRouter undoes a failed replacement: the partial replacement
// goes, the old router gets its name back and runs again if it ran before.
// It runs on its own deadline so an expired repair cannot strand the router.
func (c *Client) restoreSetAsideRouter(ctx context.Context, oldID, name string, running bool, cause error, renamed bool) error {
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deploymentRouterRollbackTimeout)
	defer cancel()
	var restoreErr error
	if renamed {
		// The name now belongs to the partial replacement, if it was created.
		if err := c.removeContainerByName(rollbackCtx, name, true); err != nil {
			restoreErr = err
		} else if err := c.RenameContainer(rollbackCtx, oldID, name); err != nil {
			restoreErr = err
		}
	}
	if restoreErr == nil && running {
		if _, err := c.cli.ContainerStart(rollbackCtx, oldID, mobyclient.ContainerStartOptions{}); err != nil {
			restoreErr = err
		}
	}
	if restoreErr != nil {
		return fmt.Errorf("%w; restoring the previous router failed: %v", cause, restoreErr)
	}
	return cause
}

// heredocRouterConfig is the first config a router start command writes.
var heredocRouterConfig = regexp.MustCompile(`<<'EOF'[^\n]*\n([\s\S]*?)\nEOF\n`)

// deploymentRouterServedConfig returns the config a router serves: the file
// on disk, which every config write replaces, else, for a router that never
// started, the config its start command writes.
func (c *Client) deploymentRouterServedConfig(ctx context.Context, current container.InspectResponse) (string, error) {
	content, err := c.readContainerFile(ctx, current.ID, deploymentRouterConfigPath, deploymentRouterOutputLimit)
	if err != nil && !isNotFoundErr(err) {
		return "", fmt.Errorf("read router config: %w", err)
	}
	if err == nil && deploymentRouterConfigSlot(string(content)) != "" {
		return string(content), nil
	}
	script := strings.Join(current.Config.Cmd, " ")
	if match := heredocRouterConfig.FindStringSubmatch(script); match != nil && deploymentRouterConfigSlot(match[1]) != "" {
		// The config the start command writes, not the whole script.
		return match[1], nil
	}
	if deploymentRouterConfigSlot(script) != "" {
		return script, nil
	}
	return "", errors.New("router config does not name one deployment slot")
}

// deploymentRouterConfigRoutes reads the served slot and the routes back from
// a router config (current or legacy format). Each server block listens on a
// published host port and proxies to a container port of the slot. The
// listen ports must be exactly the ports the router publishes, on the same
// host port, so the replacement publishes what the old router did.
func deploymentRouterConfigRoutes(config string, bindings network.PortMap) (string, []deploymentRouteConfig, error) {
	slot := deploymentRouterConfigSlot(config)
	if slot == "" {
		return "", nil, errors.New("router config does not name one deployment slot")
	}
	published := map[string]network.PortBinding{}
	for port, portBindings := range bindings {
		binding := network.PortBinding{}
		if len(portBindings) > 0 {
			binding = portBindings[0]
		}
		published[port.String()] = binding
	}
	var routes []deploymentRouteConfig
	seen := map[string]bool{}
	for _, block := range strings.Split(config, "server {")[1:] {
		listen := deploymentRouterListen.FindStringSubmatch(block)
		upstream := deploymentRouterUpstream.FindStringSubmatch(block)
		if upstream == nil {
			upstream = legacyDeploymentRouterUpstream.FindStringSubmatch(block)
		}
		if listen == nil || upstream == nil {
			return "", nil, errors.New("router config has a server without a listen port or slot upstream")
		}
		hostPort, err := strconv.ParseUint(listen[1], 10, 16)
		if err != nil || hostPort == 0 {
			return "", nil, fmt.Errorf("router config listens on invalid port %q", listen[1])
		}
		containerPort, err := strconv.ParseUint(upstream[2], 10, 16)
		if err != nil || containerPort == 0 {
			return "", nil, fmt.Errorf("router config proxies to invalid port %q", upstream[2])
		}
		key := fmt.Sprintf("%d/tcp", hostPort)
		binding, ok := published[key]
		if !ok || seen[key] {
			return "", nil, fmt.Errorf("router config port %d does not match the published ports", hostPort)
		}
		if binding.HostPort != "" && binding.HostPort != listen[1] {
			return "", nil, fmt.Errorf("router publishes port %d on host port %s", hostPort, binding.HostPort)
		}
		seen[key] = true
		hostIP := "0.0.0.0"
		if binding.HostIP.IsValid() {
			hostIP = binding.HostIP.String()
		}
		routes = append(routes, deploymentRouteConfig{HostPort: uint16(hostPort), HostIP: hostIP, ContainerPort: uint16(containerPort)})
	}
	if len(routes) == 0 || len(routes) != len(published) {
		return "", nil, errors.New("router config routes do not match the published ports")
	}
	routes[0].IsPrimary = true
	return slot, routes, nil
}

// repairDeploymentRouters runs the startup router repair for every deployment
// (policyID ""), or the serving repair for the deployments of the availability
// policy this node now serves, and logs what it did.
func (p *DockerPlugin) repairDeploymentRouters(policyID string, timeout time.Duration) {
	if p.client == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var scope deploymentRouterRepairScope
	if policyID != "" {
		// The lease holder serves the policy's deployments right now.
		scope.serving = true
		identities := p.availability.leaseRuntimeIdentities()
		scope.include = func(apps []ContainerInfo) bool {
			for _, app := range apps {
				if app.Labels[availabilityPolicyLabel] == policyID {
					return true
				}
				// The origin deployment of a policy carries no availability
				// labels; its placement recorded its slot containers (D1).
				if placement, ok := identities.match(app.ID, []string{app.Name}, app.Labels); ok && placement.PolicyID == policyID {
					return true
				}
			}
			return false
		}
	}
	lock := func(ctx context.Context, deploymentID string) (func(), error) {
		lockCtx, cancelLock := context.WithTimeout(ctx, deploymentRouterRepairLockWait)
		defer cancelLock()
		return p.lockDeployment(lockCtx, deploymentID)
	}
	repairs, err := p.client.repairServingDeploymentRouters(ctx, scope, lock)
	for _, repair := range repairs {
		p.logger.Info("deployment router brought back", "deployment_id", repair.DeploymentID, "router", repair.Router, "action", repair.Action, "policy_id", policyID)
	}
	if err != nil {
		p.logger.Warn("deployment router repair incomplete; the next start, restart or switch of the deployment recreates its router", "policy_id", policyID, "error", err)
	}
}
