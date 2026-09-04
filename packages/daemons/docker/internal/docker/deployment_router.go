package docker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

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
		hostIP := strings.TrimSpace(route.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		parsedHostIP, err := netip.ParseAddr(hostIP)
		if err != nil {
			return "", fmt.Errorf("parse router host IP: %w", err)
		}
		portBindings[port] = []network.PortBinding{{HostIP: parsedHostIP, HostPort: fmt.Sprintf("%d", route.HostPort)}}
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
	actual := map[string]string{}
	if inspect.Container.HostConfig != nil {
		for port, bindings := range inspect.Container.HostConfig.PortBindings {
			hostIP := "0.0.0.0"
			if len(bindings) > 0 && bindings[0].HostIP.IsValid() {
				hostIP = bindings[0].HostIP.String()
			}
			actual[port.String()] = hostIP
		}
	}
	desired := map[string]string{}
	for _, route := range routes {
		hostIP := strings.TrimSpace(route.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		desired[fmt.Sprintf("%d/tcp", route.HostPort)] = hostIP
	}
	if len(actual) != len(desired) {
		return true, nil
	}
	for port, hostIP := range desired {
		if actual[port] != hostIP {
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
	return c.EnsureImage(ctx, imageRef, registryAuth)
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
