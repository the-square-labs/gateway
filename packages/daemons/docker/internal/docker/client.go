package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/netip"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/distribution/reference"
	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/gpu"
)

const (
	defaultContainerStopTimeoutSeconds = 20
	maxDockerLogReadBytes              = 8 * 1024 * 1024
	maxDockerLogLineBytes              = 1024 * 1024
	gatewayGPUGroupIDsLabel            = "wiolett.gateway.gpu.group-ids"
	gatewayGPUGroupIDsVersionLabel     = "wiolett.gateway.gpu.group-ids-version"
	gatewayGPUGroupIDsVersion          = "1"
)

var errDockerLogsTooLarge = errors.New("docker logs response exceeds safety limit")

var detailedContainerTopArgs = []string{"-eo", "pid,user,%cpu,%mem,vsz,rss,tty,stat,start,time,comm"}

// Client wraps the Docker SDK client with convenience methods.
type Client struct {
	cli                      *client.Client
	logger                   *slog.Logger
	gpuInventory             gpuInventory
	databaseTunnelDirectory  string
	runscHealthy             atomic.Bool
	managedVolumeCreateMutex sync.Mutex
}

func (c *Client) SetRunscHealthy(healthy bool) {
	c.runscHealthy.Store(healthy)
}

type gpuInventory interface {
	Collect(context.Context) []gpu.Device
	Resolve(context.Context, []string) ([]gpu.Device, error)
}

type HTTPProbeConfig struct {
	Scheme         string `json:"scheme"`
	HostPort       uint16 `json:"hostPort"`
	Path           string `json:"path"`
	StatusMin      int    `json:"statusMin"`
	StatusMax      int    `json:"statusMax"`
	ExpectedBody   string `json:"expectedBody"`
	BodyMatchMode  string `json:"bodyMatchMode"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	SlowThreshold  int64  `json:"slowThreshold"`
}

type HTTPProbeResult struct {
	OK         bool   `json:"ok"`
	Status     string `json:"status"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	ResponseMs int64  `json:"responseMs,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ContainerInfo holds summary information about a container.
type ContainerInfo struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	State   string            `json:"state"`
	Status  string            `json:"status"`
	Created int64             `json:"created"`
	Ports   []PortInfo        `json:"ports"`
	Labels  map[string]string `json:"labels,omitempty"`
}

// PortInfo describes a port mapping on a container.
type PortInfo struct {
	PrivatePort uint16 `json:"privatePort"`
	PublicPort  uint16 `json:"publicPort,omitempty"`
	Type        string `json:"type"`
	IP          string `json:"ip,omitempty"`
}

// NewClient creates a Docker SDK client connected to the given socket path.
func NewClient(socketPath string, stateDir string, logger *slog.Logger) (*Client, error) {
	cli, err := client.NewClientWithOpts(
		client.WithHost(socketPath),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	return &Client{
		cli:                     cli,
		logger:                  logger,
		gpuInventory:            gpu.NewCollector(logger),
		databaseTunnelDirectory: filepath.Join(stateDir, DatabaseTunnelSocketDirectory),
	}, nil
}

// Close releases the underlying Docker client resources.
func (c *Client) Close() error {
	return c.cli.Close()
}

// Ping checks connectivity to the Docker daemon.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.cli.Ping(ctx, client.PingOptions{})
	if err != nil {
		return fmt.Errorf("docker ping: %w", err)
	}
	return nil
}

// GetVersion returns the Docker engine version string.
func (c *Client) GetVersion(ctx context.Context) (string, error) {
	ver, err := c.cli.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return "", fmt.Errorf("docker version: %w", err)
	}
	return ver.Version, nil
}

// CountContainers returns the number of running, stopped, and total containers.
func (c *Client) CountContainers(ctx context.Context) (running, stopped, total int, err error) {
	result, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return 0, 0, 0, fmt.Errorf("container list: %w", err)
	}
	total = len(result.Items)
	for _, ctr := range result.Items {
		if string(ctr.State) == "running" {
			running++
		} else {
			stopped++
		}
	}
	return running, stopped, total, nil
}

// ListContainers returns summary info for all containers (running and stopped).
func (c *Client) ListContainers(ctx context.Context) ([]ContainerInfo, error) {
	result, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("container list: %w", err)
	}

	containers := make([]ContainerInfo, 0, len(result.Items))
	for _, ctr := range result.Items {
		name := ""
		if len(ctr.Names) > 0 {
			name = strings.TrimPrefix(ctr.Names[0], "/")
		}

		ports := make([]PortInfo, 0, len(ctr.Ports))
		for _, p := range ctr.Ports {
			pi := PortInfo{
				PrivatePort: p.PrivatePort,
				PublicPort:  p.PublicPort,
				Type:        p.Type,
			}
			if p.IP.IsValid() {
				pi.IP = p.IP.String()
			}
			ports = append(ports, pi)
		}

		containers = append(containers, ContainerInfo{
			ID:      ctr.ID,
			Name:    name,
			Image:   ctr.Image,
			State:   string(ctr.State),
			Status:  ctr.Status,
			Created: ctr.Created,
			Ports:   ports,
			Labels:  ctr.Labels,
		})
	}
	return containers, nil
}

// InspectContainer returns the full inspect JSON for a container.
func (c *Client) InspectContainer(ctx context.Context, id string) (json.RawMessage, error) {
	result, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("container inspect: %w", err)
	}
	data, err := json.Marshal(result.Container)
	if err != nil {
		return nil, fmt.Errorf("marshal inspect: %w", err)
	}
	return data, nil
}

// StartContainer starts a stopped container.
func (c *Client) StartContainer(ctx context.Context, id string) error {
	if _, err := c.cli.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("container start: %w", err)
	}
	return nil
}

// StopContainer stops a running container with a timeout in seconds.
func (c *Client) StopContainer(ctx context.Context, id string, timeoutSec int) error {
	if _, err := c.cli.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &timeoutSec}); err != nil {
		return fmt.Errorf("container stop: %w", err)
	}
	return nil
}

// RestartContainer restarts a container with a timeout in seconds.
func (c *Client) RestartContainer(ctx context.Context, id string, timeoutSec int) error {
	if _, err := c.cli.ContainerRestart(ctx, id, client.ContainerRestartOptions{Timeout: &timeoutSec}); err != nil {
		return fmt.Errorf("container restart: %w", err)
	}
	return nil
}

// KillContainer sends a signal to a container.
func (c *Client) KillContainer(ctx context.Context, id string, signal string) error {
	if _, err := c.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal}); err != nil {
		return fmt.Errorf("container kill: %w", err)
	}
	return nil
}

// RemoveContainer removes a container, optionally with force.
func (c *Client) RemoveContainer(ctx context.Context, id string, force bool) error {
	if _, err := c.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: force}); err != nil {
		return fmt.Errorf("container remove: %w", err)
	}
	return nil
}

// RenameContainer renames a container.
func (c *Client) RenameContainer(ctx context.Context, id string, newName string) error {
	if _, err := c.cli.ContainerRename(ctx, id, client.ContainerRenameOptions{NewName: newName}); err != nil {
		return fmt.Errorf("container rename: %w", err)
	}
	return nil
}

// ContainerStatsOnce fetches a one-shot stats snapshot for a container.
func (c *Client) ContainerStatsOnce(ctx context.Context, id string) (json.RawMessage, error) {
	result, err := c.cli.ContainerStats(ctx, id, client.ContainerStatsOptions{
		Stream:                false,
		IncludePreviousSample: true,
	})
	if err != nil {
		return nil, fmt.Errorf("container stats: %w", err)
	}
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		return nil, fmt.Errorf("read stats body: %w", err)
	}
	return json.RawMessage(body), nil
}

// ContainerTop returns the running processes inside a container (like docker top).
func (c *Client) ContainerTop(ctx context.Context, id string) (json.RawMessage, error) {
	top, err := c.cli.ContainerTop(ctx, id, client.ContainerTopOptions{Arguments: detailedContainerTopArgs})
	if err != nil {
		fallbackTop, fallbackErr := c.cli.ContainerTop(ctx, id, client.ContainerTopOptions{})
		if fallbackErr != nil {
			return nil, fmt.Errorf("container top: detailed ps args failed: %w; fallback without ps_args failed: %v", err, fallbackErr)
		}
		top = fallbackTop
	}
	data, err := json.Marshal(top)
	if err != nil {
		return nil, fmt.Errorf("marshal top: %w", err)
	}
	return data, nil
}

// ContainerLogs retrieves the last `tail` lines of logs from a container.
// It strips the 8-byte Docker multiplexed log header from each frame.
// Optional since/until parameters filter by RFC3339 timestamp range.
func (c *Client) ContainerLogs(ctx context.Context, id string, tail int, timestamps bool, since string, until string) ([]string, error) {
	// Docker quirk: --tail + --until don't work together correctly.
	// When until is set, use expanding time windows to find enough lines efficiently.
	if until != "" && tail > 0 {
		return c.containerLogsWithUntil(ctx, id, tail, timestamps, since, until)
	}

	tailStr := "all"
	if tail > 0 {
		tailStr = strconv.Itoa(tail)
	}

	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Tail:       tailStr,
		Timestamps: timestamps,
	}
	if since != "" {
		opts.Since = since
	}
	if until != "" {
		opts.Until = until
	}

	reader, err := c.cli.ContainerLogs(ctx, id, opts)
	if err != nil {
		return nil, fmt.Errorf("container logs: %w", err)
	}
	defer reader.Close()

	return parseDockerLogsBounded(reader, tail, maxDockerLogReadBytes)
}

// containerLogsWithUntil fetches the last `tail` lines before `until` using expanding time windows.
// Docker's --tail + --until don't work together, so we use --since + --until in expanding windows.
func (c *Client) containerLogsWithUntil(ctx context.Context, id string, tail int, timestamps bool, since string, until string) ([]string, error) {
	untilTime, err := time.Parse(time.RFC3339Nano, until)
	if err != nil {
		return nil, fmt.Errorf("invalid docker logs until timestamp: %w", err)
	}

	// Try expanding time windows. Start small so busy containers do not require
	// parsing an hour of logs just to return the previous page.
	windows := []time.Duration{
		30 * time.Second,
		2 * time.Minute,
		10 * time.Minute,
		1 * time.Hour,
		6 * time.Hour,
		24 * time.Hour,
		7 * 24 * time.Hour,
		30 * 24 * time.Hour,
		90 * 24 * time.Hour,
		365 * 24 * time.Hour,
		10 * 365 * 24 * time.Hour,
	}

	var lastLines []string
	for _, window := range windows {
		windowSince := untilTime.Add(-window).Format(time.RFC3339Nano)
		if since != "" {
			// Don't go before the explicit since
			sinceTime, _ := time.Parse(time.RFC3339Nano, since)
			if untilTime.Add(-window).Before(sinceTime) {
				windowSince = since
			}
		}

		opts := client.ContainerLogsOptions{
			ShowStdout: true,
			ShowStderr: true,
			Tail:       "all",
			Timestamps: timestamps,
			Since:      windowSince,
			Until:      until,
		}

		reader, err := c.cli.ContainerLogs(ctx, id, opts)
		if err != nil {
			return nil, fmt.Errorf("container logs: %w", err)
		}

		lines, err := parseDockerLogsBounded(reader, tail, maxDockerLogReadBytes)
		reader.Close()
		if err != nil {
			if errors.Is(err, errDockerLogsTooLarge) {
				return nil, fmt.Errorf("container logs history window is too large; narrow the range or reduce log volume")
			}
			return nil, err
		}

		if len(lines) >= tail {
			// Got enough — return the last `tail` lines
			return lines[len(lines)-tail:], nil
		}
		if len(lines) > 0 {
			lastLines = lines
		}

		// If we got some lines but not enough, and since was limiting us, return what we have
		if since != "" && windowSince == since {
			return lines, nil
		}
	}

	if len(lastLines) > 0 {
		return lastLines, nil
	}
	return []string{}, nil
}

// ContainerLogsFollow opens a follow-mode log stream for a container.
// It returns the io.ReadCloser and the caller is responsible for closing it.
// The stream will continue until the context is cancelled or the container stops.
// Optional since parameter starts streaming from the given RFC3339 timestamp.
func (c *Client) ContainerLogsFollow(ctx context.Context, id string, tail int, timestamps bool, since string) (io.ReadCloser, error) {
	tailStr := "0"
	if tail > 0 {
		tailStr = strconv.Itoa(tail)
	}

	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       tailStr,
		Timestamps: timestamps,
	}
	if since != "" {
		opts.Since = since
	}

	reader, err := c.cli.ContainerLogs(ctx, id, opts)
	if err != nil {
		return nil, fmt.Errorf("container logs follow: %w", err)
	}

	return reader, nil
}

// ── Container Create / Duplicate / Update ─────────────────────────

// ContainerCreateConfig is the JSON structure accepted by CreateContainer.
// It maps closely to the Docker API container creation parameters.
type ContainerCreateConfig struct {
	Name        string            `json:"name"`
	Image       string            `json:"image"`
	Cmd         []string          `json:"cmd,omitempty"`
	Entrypoint  []string          `json:"entrypoint,omitempty"`
	Env         []string          `json:"env,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	WorkingDir  string            `json:"working_dir,omitempty"`
	User        string            `json:"user,omitempty"`
	Hostname    string            `json:"hostname,omitempty"`
	StopTimeout *int              `json:"stopTimeout,omitempty"`
	Tty         bool              `json:"tty,omitempty"`
	OpenStdin   bool              `json:"open_stdin,omitempty"`

	// Host config
	Binds        []string               `json:"binds,omitempty"`
	PortBindings map[string]string      `json:"port_bindings,omitempty"` // "80/tcp": "8080"
	Ports        []containerPortMapping `json:"ports,omitempty"`
	NetworkMode  string                 `json:"network_mode,omitempty"`
	// NetworkAliases are scoped to NetworkMode. They are used by first-party
	// database connector sidecars so application containers never need a host
	// port or a daemon address.
	NetworkAliases []string `json:"network_aliases,omitempty"`
	RestartPolicy  string   `json:"restartPolicy,omitempty"` // "no", "always", "unless-stopped", "on-failure"
	// Backward-compatible alias for older daemon-local config payloads.
	RestartPolicyLegacy string     `json:"restart_policy,omitempty"`
	Privileged          bool       `json:"privileged,omitempty"`
	CapAdd              []string   `json:"cap_add,omitempty"`
	CapDrop             []string   `json:"cap_drop,omitempty"`
	ExtraHosts          []string   `json:"extra_hosts,omitempty"`
	GPU                 *GPUConfig `json:"gpu,omitempty"`
	RuntimeProfile      string     `json:"runtimeProfile,omitempty"`
	// InternalWorkload is set only by Gateway-owned backend flows. Public
	// container creation schemas reject this field.
	InternalWorkload string `json:"internal_workload,omitempty"`
}

type containerPortMapping struct {
	HostIP        string `json:"hostIp,omitempty"`
	HostPort      uint16 `json:"hostPort"`
	ContainerPort uint16 `json:"containerPort"`
	Protocol      string `json:"protocol"`
}

func dockerPortMappings(mappings []containerPortMapping) (network.PortSet, network.PortMap, error) {
	exposedPorts := make(network.PortSet)
	portBindings := make(network.PortMap)
	for _, mapping := range mappings {
		protocol := strings.ToLower(strings.TrimSpace(mapping.Protocol))
		if protocol == "" {
			protocol = "tcp"
		}
		if protocol != "tcp" && protocol != "udp" {
			return nil, nil, fmt.Errorf("unsupported port protocol %q", mapping.Protocol)
		}
		if mapping.ContainerPort == 0 {
			return nil, nil, fmt.Errorf("container port must be greater than zero")
		}
		containerPort, err := network.ParsePort(fmt.Sprintf("%d/%s", mapping.ContainerPort, protocol))
		if err != nil {
			return nil, nil, fmt.Errorf("parse port %d/%s: %w", mapping.ContainerPort, protocol, err)
		}
		hostIP := strings.TrimSpace(mapping.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		parsedHostIP, err := netip.ParseAddr(hostIP)
		if err != nil {
			return nil, nil, fmt.Errorf("parse host IP %q: %w", hostIP, err)
		}
		exposedPorts[containerPort] = struct{}{}
		portBindings[containerPort] = append(portBindings[containerPort], network.PortBinding{
			HostIP: parsedHostIP, HostPort: fmt.Sprintf("%d", mapping.HostPort),
		})
	}
	return exposedPorts, portBindings, nil
}

// GPUConfig is a node-scoped, Gateway-owned selection. Empty deviceIds is an
// explicit detach request during recreate; an omitted GPU field preserves the
// existing HostConfig mapping.
type GPUConfig struct {
	DeviceIDs []string `json:"deviceIds"`
}

func (cfg ContainerCreateConfig) effectiveRestartPolicy() string {
	if cfg.RestartPolicy != "" {
		return cfg.RestartPolicy
	}
	return cfg.RestartPolicyLegacy
}

// GPUDevices returns the daemon-authoritative inventory with Docker-specific
// NVIDIA runtime readiness applied. Monitoring-only daemons intentionally do
// not make this additional Docker check.
func (c *Client) GPUDevices(ctx context.Context) []gpu.Device {
	if c.gpuInventory == nil {
		return nil
	}
	devices := c.gpuInventory.Collect(ctx)
	return gpu.ApplyNVIDIAContainerRuntimeReadiness(devices, c.nvidiaRuntimeAvailable(ctx))
}

func (c *Client) nvidiaRuntimeAvailable(ctx context.Context) bool {
	if c.cli == nil {
		return false
	}
	info, err := c.cli.Info(ctx, client.InfoOptions{})
	if err != nil {
		return false
	}
	_, available := info.Info.Runtimes["nvidia"]
	return available
}

type gpuSelection struct {
	devices []gpu.Device
}

func (c *Client) resolveGPUConfig(ctx context.Context, config *GPUConfig) (*gpuSelection, error) {
	if config == nil {
		return nil, nil
	}
	if c.gpuInventory == nil {
		return nil, fmt.Errorf("GPU discovery is unavailable on this Docker daemon")
	}
	devices, err := c.gpuInventory.Resolve(ctx, config.DeviceIDs)
	if err != nil {
		return nil, err
	}
	for _, device := range devices {
		if device.Vendor == gpu.VendorNVIDIA && !c.nvidiaRuntimeAvailable(ctx) {
			return nil, fmt.Errorf("GPU device %q is unavailable: NVIDIA Container Toolkit is not configured in Docker", device.ID)
		}
	}
	return &gpuSelection{devices: devices}, nil
}

func (c *Client) applyGPUConfig(ctx context.Context, containerCfg *container.Config, hostCfg *container.HostConfig, config *GPUConfig) error {
	selection, err := c.resolveGPUConfig(ctx, config)
	if err != nil {
		return err
	}
	c.applyResolvedGPUSelection(containerCfg, hostCfg, selection)
	return nil
}

func (c *Client) applyResolvedGPUSelection(containerCfg *container.Config, hostCfg *container.HostConfig, selection *gpuSelection) {
	if selection == nil {
		return
	}
	previousManagedGroupIDs := managedGPUGroupIDs(containerCfg)
	nextManagedGroupIDs := applyGPUSelection(hostCfg, selection.devices, previousManagedGroupIDs)
	setManagedGPUGroupIDs(containerCfg, nextManagedGroupIDs)
}

// applyGPUSelection only changes Gateway-managed GPU entries. It deliberately
// leaves unrelated HostConfig devices intact so a GPU edit cannot become a
// generic host-device rewrite.
func applyGPUSelection(hostCfg *container.HostConfig, devices []gpu.Device, previousManagedGroupIDs []string) []string {
	if hostCfg == nil {
		return nil
	}
	filteredRequests := hostCfg.DeviceRequests[:0]
	for _, request := range hostCfg.DeviceRequests {
		if isGatewayNVIDIARequest(request) {
			continue
		}
		filteredRequests = append(filteredRequests, request)
	}
	hostCfg.DeviceRequests = filteredRequests

	filteredMappings := hostCfg.Devices[:0]
	for _, mapping := range hostCfg.Devices {
		if isGatewayDirectGPUPath(mapping.PathOnHost) {
			continue
		}
		filteredMappings = append(filteredMappings, mapping)
	}
	hostCfg.Devices = filteredMappings
	if hostCfg.Runtime == "nvidia" {
		hostCfg.Runtime = ""
	}

	nvidiaIDs := make([]string, 0, len(devices))
	groupIDs := withoutStrings(hostCfg.GroupAdd, previousManagedGroupIDs)
	currentGroupIDs := make(map[string]struct{}, len(groupIDs))
	for _, groupID := range groupIDs {
		currentGroupIDs[groupID] = struct{}{}
	}
	previousManagedSet := make(map[string]struct{}, len(previousManagedGroupIDs))
	for _, groupID := range previousManagedGroupIDs {
		previousManagedSet[groupID] = struct{}{}
	}
	nextManagedGroupIDs := []string{}
	mappedPaths := make(map[string]struct{}, len(hostCfg.Devices))
	for _, mapping := range hostCfg.Devices {
		mappedPaths[mapping.PathOnHost] = struct{}{}
	}
	for _, device := range devices {
		switch device.Vendor {
		case gpu.VendorNVIDIA:
			if device.RuntimeID != "" {
				nvidiaIDs = append(nvidiaIDs, device.RuntimeID)
			}
		case gpu.VendorAMD, gpu.VendorIntel:
			for _, path := range device.DevicePaths {
				if _, exists := mappedPaths[path]; exists {
					continue
				}
				mappedPaths[path] = struct{}{}
				hostCfg.Devices = append(hostCfg.Devices, container.DeviceMapping{
					PathOnHost:        path,
					PathInContainer:   path,
					CgroupPermissions: "rwm",
				})
			}
			for _, groupID := range device.GroupIDs {
				if groupID == "" {
					continue
				}
				_, alreadyPresent := currentGroupIDs[groupID]
				_, wasGatewayManaged := previousManagedSet[groupID]
				if !alreadyPresent {
					groupIDs = append(groupIDs, groupID)
					currentGroupIDs[groupID] = struct{}{}
				}
				if wasGatewayManaged || !alreadyPresent {
					nextManagedGroupIDs = appendUniqueStrings(nextManagedGroupIDs, groupID)
				}
			}
		}
	}
	if len(nvidiaIDs) > 0 {
		hostCfg.DeviceRequests = append(hostCfg.DeviceRequests, container.DeviceRequest{
			Driver:       "nvidia",
			DeviceIDs:    nvidiaIDs,
			Capabilities: [][]string{{"gpu"}},
		})
	}
	hostCfg.GroupAdd = groupIDs
	return nextManagedGroupIDs
}

func managedGPUGroupIDs(containerCfg *container.Config) []string {
	if containerCfg == nil || containerCfg.Labels == nil || containerCfg.Labels[gatewayGPUGroupIDsVersionLabel] != gatewayGPUGroupIDsVersion {
		return nil
	}
	return parseGPUGroupIDs(containerCfg.Labels[gatewayGPUGroupIDsLabel])
}

func preserveGatewayManagedContainerLabels(existing map[string]string, replacement map[string]string) {
	if replacement == nil {
		return
	}
	if existing != nil {
		if value, exists := existing[archiveImageReferenceLabel]; exists {
			replacement[archiveImageReferenceLabel] = value
		}
	}
	// GPU group provenance is daemon-owned metadata. Never admit values from a
	// caller: an untracked label must not turn a pre-existing group into one we
	// are allowed to remove on a later detach.
	for _, label := range []string{gatewayGPUGroupIDsLabel, gatewayGPUGroupIDsVersionLabel} {
		if existing == nil {
			delete(replacement, label)
			continue
		}
		if value, exists := existing[label]; exists {
			replacement[label] = value
		} else {
			delete(replacement, label)
		}
	}
}

func setManagedGPUGroupIDs(containerCfg *container.Config, groupIDs []string) {
	if containerCfg == nil {
		return
	}
	if len(groupIDs) == 0 {
		if containerCfg.Labels != nil {
			delete(containerCfg.Labels, gatewayGPUGroupIDsLabel)
			delete(containerCfg.Labels, gatewayGPUGroupIDsVersionLabel)
		}
		return
	}
	sort.Strings(groupIDs)
	if containerCfg.Labels == nil {
		containerCfg.Labels = map[string]string{}
	}
	containerCfg.Labels[gatewayGPUGroupIDsLabel] = strings.Join(groupIDs, ",")
	containerCfg.Labels[gatewayGPUGroupIDsVersionLabel] = gatewayGPUGroupIDsVersion
}

func parseGPUGroupIDs(value string) []string {
	return appendUniqueStrings(nil, strings.Split(value, ",")...)
}

func withoutStrings(values []string, remove []string) []string {
	if len(remove) == 0 {
		return append([]string(nil), values...)
	}
	removed := make(map[string]struct{}, len(remove))
	for _, value := range remove {
		if value != "" {
			removed[value] = struct{}{}
		}
	}
	filtered := make([]string, 0, len(values))
	for _, value := range values {
		if _, shouldRemove := removed[value]; !shouldRemove {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func isGatewayNVIDIARequest(request container.DeviceRequest) bool {
	driver := strings.TrimSpace(request.Driver)
	if driver != "" && !strings.EqualFold(driver, "nvidia") {
		return false
	}
	if len(request.DeviceIDs) == 0 || len(request.Capabilities) != 1 || len(request.Capabilities[0]) != 1 || !strings.EqualFold(request.Capabilities[0][0], "gpu") {
		return false
	}
	return len(request.Options) == 0 && request.Count == 0
}

func isGatewayDirectGPUPath(path string) bool {
	return path == "/dev/kfd" || strings.HasPrefix(path, "/dev/dri/renderD")
}

func appendUniqueStrings(values []string, additions ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(additions))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	for _, value := range additions {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

// CreateContainer parses configJSON into a container config and creates the container.
// Returns the container ID and name.
func (c *Client) CreateContainer(ctx context.Context, configJSON string) (string, string, error) {
	var cfg ContainerCreateConfig
	decoder := json.NewDecoder(strings.NewReader(configJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return "", "", fmt.Errorf("parse container config: %w", err)
	}

	if cfg.Image == "" {
		return "", "", fmt.Errorf("image is required")
	}
	if cfg.Privileged || len(cfg.CapAdd) > 0 {
		return "", "", fmt.Errorf("privileged mode and added capabilities are not allowed for user workloads")
	}
	if hasHostBind(cfg.Binds) && !c.isManagedDatabaseConnector(cfg) {
		return "", "", fmt.Errorf("host bind mounts are not allowed for new user workloads")
	}
	containerCfg := &container.Config{
		Image:       cfg.Image,
		Cmd:         cfg.Cmd,
		Entrypoint:  cfg.Entrypoint,
		Env:         cfg.Env,
		Labels:      cfg.Labels,
		WorkingDir:  cfg.WorkingDir,
		User:        cfg.User,
		Hostname:    cfg.Hostname,
		StopTimeout: cfg.StopTimeout,
		Tty:         cfg.Tty,
		OpenStdin:   cfg.OpenStdin,
	}

	hostCfg := &container.HostConfig{
		Binds:       cfg.Binds,
		NetworkMode: container.NetworkMode(cfg.NetworkMode),
		Privileged:  cfg.Privileged,
		CapAdd:      cfg.CapAdd,
		CapDrop:     cfg.CapDrop,
		ExtraHosts:  cfg.ExtraHosts,
	}
	applyUserWorkloadBaseline(hostCfg)
	if err := c.applyRuntimeProfile(hostCfg, cfg.RuntimeProfile, cfg.GPU); err != nil {
		return "", "", err
	}
	if cfg.GPU != nil {
		if err := c.applyGPUConfig(ctx, containerCfg, hostCfg, cfg.GPU); err != nil {
			return "", "", err
		}
	}

	if cfg.Ports != nil {
		exposedPorts, portMap, err := dockerPortMappings(cfg.Ports)
		if err != nil {
			return "", "", err
		}
		containerCfg.ExposedPorts = exposedPorts
		hostCfg.PortBindings = portMap
	} else if len(cfg.PortBindings) > 0 {
		// Backward-compatible daemon-local create format: "80/tcp" -> "8080".
		portMap := make(network.PortMap)
		for containerPort, hostPort := range cfg.PortBindings {
			port, err := network.ParsePort(containerPort)
			if err != nil {
				return "", "", fmt.Errorf("parse port %q: %w", containerPort, err)
			}
			portMap[port] = []network.PortBinding{
				{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: hostPort},
			}
		}
		hostCfg.PortBindings = portMap
	}

	// Parse restart policy
	restartPolicy := cfg.effectiveRestartPolicy()
	if restartPolicy != "" {
		hostCfg.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(restartPolicy)}
	}

	var networkingConfig *network.NetworkingConfig
	if cfg.NetworkMode != "" && len(cfg.NetworkAliases) > 0 {
		networkingConfig = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			cfg.NetworkMode: {Aliases: cfg.NetworkAliases},
		}}
	}

	result, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           containerCfg,
		HostConfig:       hostCfg,
		NetworkingConfig: networkingConfig,
		Name:             cfg.Name,
	})
	if err != nil {
		return "", "", fmt.Errorf("create container: %w", err)
	}

	return result.ID, cfg.Name, nil
}

func (c *Client) isManagedDatabaseConnector(cfg ContainerCreateConfig) bool {
	if cfg.InternalWorkload != "managed-database-connector" ||
		!strings.HasPrefix(cfg.Name, "gateway-db-connector-") ||
		cfg.Labels["wiolett.gateway.managed-database.connector"] != "true" ||
		len(cfg.Binds) != 1 {
		return false
	}
	parts := strings.Split(cfg.Binds[0], ":")
	return len(parts) == 3 &&
		filepath.Clean(parts[0]) == filepath.Clean(c.databaseTunnelDirectory) &&
		parts[1] == "/run/gateway-db" &&
		parts[2] == "ro"
}

func applyUserWorkloadBaseline(hostCfg *container.HostConfig) {
	hostCfg.Privileged = false
	hostCfg.CapAdd = nil
	hostCfg.SecurityOpt = appendUniqueStrings(hostCfg.SecurityOpt, "no-new-privileges:true")
}

func (c *Client) applyRuntimeProfile(hostCfg *container.HostConfig, profile string, gpuConfig *GPUConfig) error {
	switch profile {
	case "", "default":
		hostCfg.Runtime = ""
		return nil
	case "secure":
		if !c.runscHealthy.Load() {
			return fmt.Errorf("Secure Runtime is not healthy on this node")
		}
		if gpuConfig != nil && len(gpuConfig.DeviceIDs) > 0 {
			return fmt.Errorf("Secure Runtime does not support GPU attachments")
		}
		if len(hostCfg.Devices) > 0 || len(hostCfg.DeviceRequests) > 0 {
			return fmt.Errorf("Secure Runtime does not support device attachments")
		}
		if hasHostBind(hostCfg.Binds) {
			return fmt.Errorf("Secure Runtime does not support host bind mounts")
		}
		hostCfg.Runtime = "runsc"
		applyUserWorkloadBaseline(hostCfg)
		return nil
	default:
		return fmt.Errorf("unsupported runtime profile %q", profile)
	}
}

func hasHostBind(binds []string) bool {
	for _, bind := range binds {
		source := strings.SplitN(bind, ":", 2)[0]
		if filepath.IsAbs(source) {
			return true
		}
	}
	return false
}

func (c *Client) HTTPProbe(ctx context.Context, configJSON string) (HTTPProbeResult, error) {
	var cfg HTTPProbeConfig
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return HTTPProbeResult{}, fmt.Errorf("parse http probe config: %w", err)
	}
	if cfg.Scheme == "" {
		cfg.Scheme = "http"
	}
	if cfg.Path == "" {
		cfg.Path = "/"
	}
	if !strings.HasPrefix(cfg.Path, "/") {
		cfg.Path = "/" + cfg.Path
	}
	if cfg.StatusMin == 0 {
		cfg.StatusMin = 200
	}
	if cfg.StatusMax == 0 {
		cfg.StatusMax = 399
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 5
	}

	url := fmt.Sprintf("%s://127.0.0.1:%d%s", cfg.Scheme, cfg.HostPort, cfg.Path)
	probeCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()

	start := time.Now()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, url, nil)
	if err != nil {
		return HTTPProbeResult{}, err
	}
	resp, err := http.DefaultClient.Do(req)
	responseMs := time.Since(start).Milliseconds()
	if err != nil {
		return HTTPProbeResult{OK: false, Status: "offline", ResponseMs: responseMs, Error: err.Error()}, nil
	}
	defer resp.Body.Close()

	passed := resp.StatusCode >= cfg.StatusMin && resp.StatusCode <= cfg.StatusMax
	if passed && cfg.ExpectedBody != "" {
		bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		if readErr != nil {
			return HTTPProbeResult{
				OK:         false,
				Status:     "offline",
				HTTPStatus: resp.StatusCode,
				ResponseMs: responseMs,
				Error:      readErr.Error(),
			}, nil
		}
		passed = httpProbeBodyMatches(string(bodyBytes), cfg.ExpectedBody, cfg.BodyMatchMode)
	}

	status := "offline"
	if passed {
		status = "online"
		if cfg.SlowThreshold > 0 && responseMs >= cfg.SlowThreshold {
			status = "degraded"
		}
	}
	return HTTPProbeResult{
		OK:         passed,
		Status:     status,
		HTTPStatus: resp.StatusCode,
		ResponseMs: responseMs,
	}, nil
}

func httpProbeBodyMatches(body string, expected string, mode string) bool {
	switch mode {
	case "exact":
		return body == expected
	case "starts_with":
		return strings.HasPrefix(body, expected)
	case "ends_with":
		return strings.HasSuffix(body, expected)
	default:
		return strings.Contains(body, expected)
	}
}

// DuplicateContainer inspects a source container and creates a new one with the
// same config and a different name.
func (c *Client) DuplicateContainer(ctx context.Context, id string, newName string) (string, error) {
	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect source container: %w", err)
	}
	insp := inspResult.Container

	// Clone config, clear runtime fields.
	cfg := *insp.Config
	cfg.Hostname = ""
	netNames := inspectNetworkNames(&insp)
	result, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           &cfg,
		HostConfig:       insp.HostConfig,
		NetworkingConfig: networkingConfigForInspectNetwork(&insp, netNames),
		Name:             newName,
	})
	if err != nil {
		return "", fmt.Errorf("create duplicate container: %w", err)
	}

	if err := c.connectContainerToAdditionalNetworks(ctx, result.ID, &insp, netNames); err != nil {
		_, _ = c.cli.ContainerRemove(ctx, result.ID, client.ContainerRemoveOptions{Force: true})
		return "", fmt.Errorf("connect duplicate container networks: %w", err)
	}

	return result.ID, nil
}

// UpdateContainer performs an update of the container configuration.
// If newTag is set, it pulls that image first, then recreates the container.
// For env-only/config-preserving updates, it recreates directly without talking
// to the registry. envOverrides are merged on top; envRemovals are stripped.
func (c *Client) UpdateContainer(ctx context.Context, id string, newTag string, envOverrides map[string]string, envRemovals []string, registryAuth string) error {
	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect container: %w", err)
	}
	insp := inspResult.Container
	rollbackSnapshot, err := cloneInspectResponse(&insp)
	if err != nil {
		return fmt.Errorf("clone container for rollback: %w", err)
	}

	imageRef := containerRecreateImageReference(&insp)
	if imageRef == "" {
		return fmt.Errorf("could not determine image for container")
	}

	// Only talk to the registry when the requested image tag changes.
	if newTag != "" {
		updateReference := containerTagUpdateImageReference(&insp)
		if !strings.Contains(updateReference, ":") {
			updateReference += ":latest"
		}
		named, err := reference.ParseNormalizedNamed(updateReference)
		if err != nil {
			return fmt.Errorf("parse image reference: %w", err)
		}
		named = reference.TrimNamed(named)
		newRef, err := reference.WithTag(named, newTag)
		if err != nil {
			return fmt.Errorf("apply tag %q: %w", newTag, err)
		}
		imageRef = newRef.String()
		if insp.Config.Labels != nil {
			if _, imported := insp.Config.Labels[archiveImageReferenceLabel]; imported {
				insp.Config.Labels[archiveImageReferenceLabel] = imageRef
			}
		}

		pullOpts := client.ImagePullOptions{}
		if registryAuth != "" {
			pullOpts.RegistryAuth = registryAuth
		}

		pullResp, err := c.cli.ImagePull(ctx, imageRef, pullOpts)
		if err != nil {
			return fmt.Errorf("pull image: %w", err)
		}
		// Drain the pull response to complete the pull.
		_, _ = io.Copy(io.Discard, pullResp)
		pullResp.Close()
	}

	return c.recreateContainer(ctx, &insp, imageRef, envOverrides, envRemovals, rollbackSnapshot)
}

// containerRecreateImageReference deliberately prefers Config.Image. Imported
// GWCA containers use an immutable image ID there, while their preserved source
// tag is only suitable for an explicit tag-changing update after a pull.
func containerRecreateImageReference(insp *container.InspectResponse) string {
	if insp != nil && insp.Config != nil {
		if imageReference := strings.TrimSpace(insp.Config.Image); imageReference != "" {
			return imageReference
		}
	}
	if insp == nil {
		return ""
	}
	return strings.TrimSpace(insp.Image)
}

func containerTagUpdateImageReference(insp *container.InspectResponse) string {
	if insp != nil && insp.Config != nil {
		if imageReference := configuredArchiveImageReference(insp.Config.Image, insp.Config.Labels); imageReference != "" {
			return imageReference
		}
	}
	return containerRecreateImageReference(insp)
}

// LiveUpdateContainer applies resource limits and restart policy to an existing container
// without recreating it. This uses Docker's ContainerUpdate API for running, restarting,
// and stopped containers.
func (c *Client) LiveUpdateContainer(ctx context.Context, id string, configJSON string) error {
	var params struct {
		RestartPolicy *string `json:"restartPolicy"`
		MaxRetries    *int    `json:"maxRetries"`
		MemoryLimit   *int64  `json:"memoryLimit"` // bytes
		MemorySwap    *int64  `json:"memorySwap"`  // bytes, -1 = unlimited
		NanoCPUs      *int64  `json:"nanoCPUs"`    // 1e9 = 1 CPU
		CpuShares     *int64  `json:"cpuShares"`
		PidsLimit     *int64  `json:"pidsLimit"` // 0 = unlimited
	}
	if err := json.Unmarshal([]byte(configJSON), &params); err != nil {
		return fmt.Errorf("parse live update params: %w", err)
	}

	opts := client.ContainerUpdateOptions{}

	// Restart policy
	if params.RestartPolicy != nil {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(*params.RestartPolicy)}
		if *params.RestartPolicy == "on-failure" && params.MaxRetries != nil {
			policy.MaximumRetryCount = *params.MaxRetries
		}
		opts.RestartPolicy = &policy
	}

	// Resource limits
	resources := container.Resources{}
	hasResources := false
	if params.MemoryLimit != nil {
		resources.Memory = *params.MemoryLimit
		hasResources = true
	}
	if params.MemorySwap != nil {
		resources.MemorySwap = *params.MemorySwap
		hasResources = true
	}
	if params.NanoCPUs != nil {
		applyNanoCPULimit(&resources, *params.NanoCPUs)
		hasResources = true
	}
	if params.CpuShares != nil {
		resources.CPUShares = *params.CpuShares
		hasResources = true
	}
	if params.PidsLimit != nil {
		pids := *params.PidsLimit
		resources.PidsLimit = &pids
		hasResources = true
	}
	if hasResources {
		opts.Resources = &resources
	}

	_, err := c.cli.ContainerUpdate(ctx, id, opts)
	if err != nil {
		return fmt.Errorf("live update container: %w", err)
	}
	return nil
}

// RecreateWithConfig stops, removes, and recreates a container with new configuration
// overrides for ports, mounts, entrypoint, command, working directory, user, hostname, and labels.
func (c *Client) RecreateWithConfig(ctx context.Context, id string, configJSON string) error {
	var params struct {
		Image     string                 `json:"image"`
		Env       map[string]string      `json:"env"`
		RemoveEnv []string               `json:"removeEnv"`
		Ports     []containerPortMapping `json:"ports"`
		Mounts    []struct {
			HostPath      string `json:"hostPath"`
			ContainerPath string `json:"containerPath"`
			Name          string `json:"name"`
			ReadOnly      bool   `json:"readOnly"`
		} `json:"mounts"`
		Entrypoint     []string          `json:"entrypoint"`
		Command        []string          `json:"command"`
		WorkingDir     string            `json:"workingDir"`
		User           string            `json:"user"`
		Hostname       string            `json:"hostname"`
		Labels         map[string]string `json:"labels"`
		StopTimeout    *int              `json:"stopTimeout"`
		RestartPolicy  *string           `json:"restartPolicy"`
		MaxRetries     *int              `json:"maxRetries"`
		MemoryLimit    *int64            `json:"memoryLimit"`
		MemorySwap     *int64            `json:"memorySwap"`
		NanoCPUs       *int64            `json:"nanoCPUs"`
		CpuShares      *int64            `json:"cpuShares"`
		PidsLimit      *int64            `json:"pidsLimit"`
		GPU            *GPUConfig        `json:"gpu"`
		RuntimeProfile *string           `json:"runtimeProfile"`
	}
	if err := json.Unmarshal([]byte(configJSON), &params); err != nil {
		return fmt.Errorf("parse recreate config: %w", err)
	}

	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect container: %w", err)
	}
	insp := inspResult.Container
	rollbackSnapshot, err := cloneInspectResponse(&insp)
	if err != nil {
		return fmt.Errorf("clone container for rollback: %w", err)
	}

	// Apply port binding overrides
	if params.Ports != nil {
		exposedPorts, portBindings, mappingErr := dockerPortMappings(params.Ports)
		if mappingErr != nil {
			return mappingErr
		}
		insp.HostConfig.PortBindings = portBindings
		insp.Config.ExposedPorts = exposedPorts
	}

	// Apply mount overrides
	if params.Mounts != nil {
		var binds []string
		for _, m := range params.Mounts {
			if m.HostPath != "" {
				bind := m.HostPath + ":" + m.ContainerPath
				if m.ReadOnly {
					bind += ":ro"
				}
				binds = append(binds, bind)
			} else if m.Name != "" {
				bind := m.Name + ":" + m.ContainerPath
				if m.ReadOnly {
					bind += ":ro"
				}
				binds = append(binds, bind)
			}
		}
		insp.HostConfig.Binds = binds
		// Clear Mounts field since we're using Binds
		insp.Mounts = nil
	}
	// Apply entrypoint override
	if params.Entrypoint != nil {
		insp.Config.Entrypoint = params.Entrypoint
	}

	// Apply command override
	if params.Command != nil {
		insp.Config.Cmd = params.Command
	}

	// Apply working directory override
	if params.WorkingDir != "" {
		insp.Config.WorkingDir = params.WorkingDir
	}

	// Apply user override
	if params.User != "" {
		insp.Config.User = params.User
	}

	// Apply hostname override
	if params.Hostname != "" {
		insp.Config.Hostname = params.Hostname
	}

	// Apply labels override
	if params.Labels != nil {
		preserveGatewayManagedContainerLabels(insp.Config.Labels, params.Labels)
		insp.Config.Labels = params.Labels
	}
	if params.StopTimeout != nil {
		insp.Config.StopTimeout = params.StopTimeout
	}

	// Apply runtime overrides to HostConfig so they persist after recreation.
	if params.RestartPolicy != nil {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(*params.RestartPolicy)}
		if *params.RestartPolicy == "on-failure" && params.MaxRetries != nil {
			policy.MaximumRetryCount = *params.MaxRetries
		}
		insp.HostConfig.RestartPolicy = policy
	} else if params.MaxRetries != nil && insp.HostConfig.RestartPolicy.Name == "on-failure" {
		insp.HostConfig.RestartPolicy.MaximumRetryCount = *params.MaxRetries
	}
	if params.MemoryLimit != nil {
		insp.HostConfig.Memory = *params.MemoryLimit
	}
	if params.MemorySwap != nil {
		insp.HostConfig.MemorySwap = *params.MemorySwap
	}
	if params.NanoCPUs != nil {
		applyNanoCPULimit(&insp.HostConfig.Resources, *params.NanoCPUs)
	}
	if params.CpuShares != nil {
		insp.HostConfig.CPUShares = *params.CpuShares
	}
	if params.PidsLimit != nil {
		pids := *params.PidsLimit
		insp.HostConfig.PidsLimit = &pids
	}
	if params.GPU != nil {
		if err := c.applyGPUConfig(ctx, insp.Config, insp.HostConfig, params.GPU); err != nil {
			return err
		}
	}
	if params.RuntimeProfile != nil {
		if err := c.applyRuntimeProfile(insp.HostConfig, *params.RuntimeProfile, params.GPU); err != nil {
			return err
		}
	}

	imageRef := params.Image
	if imageRef == "" {
		imageRef = insp.Config.Image
	} else if insp.Config.Labels != nil {
		if _, imported := insp.Config.Labels[archiveImageReferenceLabel]; imported {
			insp.Config.Labels[archiveImageReferenceLabel] = imageRef
		}
	}
	if imageRef == "" {
		imageRef = insp.Image
	}

	return c.recreateContainer(ctx, &insp, imageRef, params.Env, params.RemoveEnv, rollbackSnapshot)
}

func applyNanoCPULimit(resources *container.Resources, nanoCPUs int64) {
	resources.NanoCPUs = nanoCPUs
	resources.CPUPeriod = 0
	resources.CPUQuota = 0
}

// recreateContainer stops, removes, and recreates a container with the given
// imageRef, preserving all network connections. envOverrides are merged on top
// of the existing env; envRemovals are stripped.
func (c *Client) recreateContainer(
	ctx context.Context,
	insp *container.InspectResponse,
	imageRef string,
	envOverrides map[string]string,
	envRemovals []string,
	rollbackSnapshot *container.InspectResponse,
) error {
	name := strings.TrimPrefix(insp.Name, "/")
	if name == "" {
		name = insp.ID[:12]
	}

	wasRunning := insp.State != nil && insp.State.Running

	if wasRunning {
		timeoutSec := defaultContainerStopTimeoutSeconds
		if insp.Config != nil && insp.Config.StopTimeout != nil && *insp.Config.StopTimeout >= 0 {
			timeoutSec = *insp.Config.StopTimeout
		}
		if _, err := c.cli.ContainerStop(ctx, insp.ID, client.ContainerStopOptions{Timeout: &timeoutSec}); err != nil {
			return fmt.Errorf("stop container: %w", err)
		}
	}

	// Remove the container
	if _, err := c.cli.ContainerRemove(ctx, insp.ID, client.ContainerRemoveOptions{Force: true}); err != nil {
		return fmt.Errorf("remove container: %w", err)
	}

	if _, err := c.createContainerFromInspect(ctx, insp, imageRef, envOverrides, envRemovals); err != nil {
		if rollbackSnapshot != nil {
			rollbackImage := rollbackSnapshot.Config.Image
			if rollbackImage == "" {
				rollbackImage = rollbackSnapshot.Image
			}
			if rollbackImage == "" {
				rollbackImage = imageRef
			}
			if _, rollbackErr := c.createContainerFromInspect(ctx, rollbackSnapshot, rollbackImage, nil, nil); rollbackErr != nil {
				return fmt.Errorf("create container: %w (rollback failed: %v)", err, rollbackErr)
			}
			return fmt.Errorf("create container: %w (original container restored)", err)
		}
		return fmt.Errorf("create container: %w", err)
	}

	return nil
}

func (c *Client) createContainerFromInspect(
	ctx context.Context,
	insp *container.InspectResponse,
	imageRef string,
	envOverrides map[string]string,
	envRemovals []string,
) (string, error) {
	name := strings.TrimPrefix(insp.Name, "/")
	if name == "" {
		name = insp.ID[:12]
	}
	wasRunning := insp.State != nil && insp.State.Running

	// Build new config
	createConfig := *insp.Config
	createConfig.Image = imageRef
	createConfig.Env = applyEnvChanges(insp.Config.Env, envOverrides, envRemovals)
	// Preserve all networks the container was connected to.
	// Docker only allows one network at creation time; the rest are connected after.
	netNames := inspectNetworkNames(insp)
	hostConfig := *insp.HostConfig
	if len(netNames) > 0 {
		hostConfig.NetworkMode = container.NetworkMode(netNames[0])
	}

	createResult, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           &createConfig,
		HostConfig:       &hostConfig,
		NetworkingConfig: networkingConfigForInspectNetwork(insp, netNames),
		Name:             name,
	})
	if err != nil {
		return "", err
	}

	if err := c.connectContainerToAdditionalNetworks(ctx, createResult.ID, insp, netNames); err != nil {
		_, _ = c.cli.ContainerRemove(ctx, createResult.ID, client.ContainerRemoveOptions{Force: true})
		return "", fmt.Errorf("connect container networks: %w", err)
	}

	// Preserve the original running state. A stopped container should stay stopped.
	if wasRunning {
		if _, err := c.cli.ContainerStart(ctx, createResult.ID, client.ContainerStartOptions{}); err != nil {
			_, _ = c.cli.ContainerRemove(ctx, createResult.ID, client.ContainerRemoveOptions{Force: true})
			return "", fmt.Errorf("start container: %w", err)
		}
	}

	return createResult.ID, nil
}

func inspectNetworkNames(insp *container.InspectResponse) []string {
	if insp == nil || insp.NetworkSettings == nil || len(insp.NetworkSettings.Networks) == 0 {
		return nil
	}

	netNames := make([]string, 0, len(insp.NetworkSettings.Networks))
	for netName := range insp.NetworkSettings.Networks {
		if strings.TrimSpace(netName) != "" {
			netNames = append(netNames, netName)
		}
	}
	sort.Strings(netNames)
	currentMode := ""
	if insp.HostConfig != nil {
		currentMode = strings.TrimSpace(string(insp.HostConfig.NetworkMode))
	}
	preferred := currentMode
	if preferred == "" || preferred == "default" || preferred == "bridge" {
		for _, name := range netNames {
			if name != "bridge" && name != "default" {
				preferred = name
				break
			}
		}
	}
	for index, name := range netNames {
		if name == preferred && index > 0 {
			copy(netNames[1:index+1], netNames[0:index])
			netNames[0] = name
			break
		}
	}
	return netNames
}

func networkingConfigForInspectNetwork(
	insp *container.InspectResponse,
	netNames []string,
) *network.NetworkingConfig {
	if len(netNames) == 0 || insp == nil || insp.NetworkSettings == nil {
		return nil
	}

	ep := endpointConfigForRecreate(insp.NetworkSettings.Networks[netNames[0]])
	return &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{netNames[0]: ep},
	}
}

func endpointConfigForRecreate(source *network.EndpointSettings) *network.EndpointSettings {
	if source == nil {
		return nil
	}

	endpoint := source.Copy()
	endpoint.NetworkID = ""
	endpoint.EndpointID = ""
	endpoint.Gateway = netip.Addr{}
	endpoint.IPAddress = netip.Addr{}
	endpoint.MacAddress = nil
	endpoint.IPPrefixLen = 0
	endpoint.IPv6Gateway = netip.Addr{}
	endpoint.GlobalIPv6Address = netip.Addr{}
	endpoint.GlobalIPv6PrefixLen = 0
	endpoint.DNSNames = nil
	return endpoint
}

func (c *Client) connectContainerToAdditionalNetworks(
	ctx context.Context,
	containerID string,
	insp *container.InspectResponse,
	netNames []string,
) error {
	if insp == nil || insp.NetworkSettings == nil {
		return nil
	}

	for _, netName := range netNames[1:] {
		ep := endpointConfigForRecreate(insp.NetworkSettings.Networks[netName])
		if _, err := c.cli.NetworkConnect(ctx, netName, client.NetworkConnectOptions{
			Container:      containerID,
			EndpointConfig: ep,
		}); err != nil {
			return fmt.Errorf("connect network %q: %w", netName, err)
		}
	}
	return nil
}

func cloneInspectResponse(src *container.InspectResponse) (*container.InspectResponse, error) {
	data, err := json.Marshal(src)
	if err != nil {
		return nil, err
	}

	var cloned container.InspectResponse
	if err := json.Unmarshal(data, &cloned); err != nil {
		return nil, err
	}

	return &cloned, nil
}

// applyEnvChanges builds the final env slice by:
//  1. Stripping keys listed in removals
//  2. Applying overrides on top (overrides win on conflict; new keys are appended)
func applyEnvChanges(containerEnv []string, overrides map[string]string, removals []string) []string {
	removeSet := make(map[string]bool, len(removals))
	for _, k := range removals {
		removeSet[k] = true
	}
	seen := make(map[string]bool, len(containerEnv))
	filtered := make([]string, 0, len(containerEnv))
	for _, kv := range containerEnv {
		key := kv
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			key = kv[:idx]
		}
		if removeSet[key] {
			continue
		}
		seen[key] = true
		if val, ok := overrides[key]; ok {
			filtered = append(filtered, key+"="+val)
		} else {
			filtered = append(filtered, kv)
		}
	}
	for k, v := range overrides {
		if !seen[k] {
			filtered = append(filtered, k+"="+v)
		}
	}
	return filtered
}

// ── Image Operations ──────────────────────────────────────────────

// ListImages returns the list of images as raw JSON.
func (c *Client) ListImages(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.ImageList(ctx, client.ImageListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("image list: %w", err)
	}
	containers, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err == nil {
		result.Items = annotateImageUsage(result.Items, containers.Items)
	} else if c.logger != nil {
		c.logger.Warn("failed to calculate Docker image usage", "error", err)
	}
	data, err := json.Marshal(result.Items)
	if err != nil {
		return nil, fmt.Errorf("marshal images: %w", err)
	}
	return data, nil
}

func annotateImageUsage(images []imagetypes.Summary, containers []container.Summary) []imagetypes.Summary {
	for idx := range images {
		var count int64
		for _, ctr := range containers {
			if containerUsesImage(ctr, images[idx]) {
				count++
			}
		}
		images[idx].Containers = count
	}
	return images
}

func containerUsesImage(ctr container.Summary, image imagetypes.Summary) bool {
	if sameDockerImageID(ctr.ImageID, image.ID) {
		return true
	}
	for _, tag := range image.RepoTags {
		if tag != "" && tag != "<none>:<none>" && ctr.Image == tag {
			return true
		}
	}
	return false
}

func sameDockerImageID(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return left == right || strings.TrimPrefix(left, "sha256:") == strings.TrimPrefix(right, "sha256:")
}

// PullImage pulls an image from a registry. registryAuth is base64-encoded
// JSON credentials (may be empty for public images).
func (c *Client) PullImage(ctx context.Context, imageRef string, registryAuth string) error {
	opts := client.ImagePullOptions{}
	if registryAuth != "" {
		opts.RegistryAuth = registryAuth
	}

	resp, err := c.cli.ImagePull(ctx, imageRef, opts)
	if err != nil {
		return fmt.Errorf("image pull: %w", err)
	}
	defer resp.Close()

	// Docker streams JSON progress; errors are embedded in the stream.
	// Read and check each message for error fields.
	decoder := json.NewDecoder(resp)
	var lastErr string
	for {
		var msg struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := decoder.Decode(&msg); err != nil {
			break // EOF or parse error — done reading
		}
		if msg.Error != "" {
			lastErr = msg.Error
		}
	}
	if lastErr != "" {
		return fmt.Errorf("image pull: %s", lastErr)
	}
	return nil
}

// EnsureImage keeps an already-present exact image reference available without
// contacting a registry. Callers that require immutable image references can
// use this for local/offline nodes while retaining digest pinning themselves.
func (c *Client) EnsureImage(ctx context.Context, imageRef string, registryAuth string) error {
	if _, err := c.cli.ImageInspect(ctx, imageRef); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("inspect image: %w", err)
	}
	return c.PullImage(ctx, imageRef, registryAuth)
}

// RemoveImage removes an image by ID or reference.
func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	_, err := c.cli.ImageRemove(ctx, id, client.ImageRemoveOptions{
		Force:         force,
		PruneChildren: true,
	})
	if err != nil {
		return fmt.Errorf("image remove: %w", err)
	}
	return nil
}

// PruneImages removes unused images and returns bytes reclaimed.
func (c *Client) PruneImages(ctx context.Context) (int64, error) {
	result, err := c.cli.ImagePrune(ctx, client.ImagePruneOptions{})
	if err != nil {
		return 0, fmt.Errorf("image prune: %w", err)
	}
	return int64(result.Report.SpaceReclaimed), nil
}

// ── Volume Operations ─────────────────────────────────────────────

const managedVolumeLabel = "com.wiolett.gateway.managed-volume"
const managedVolumeOriginLabel = "com.wiolett.gateway.managed-volume-origin"

func (c *Client) collectVolumeUsers(ctx context.Context) map[string][]string {
	volumeUsers := make(map[string][]string)
	ctrResult, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return volumeUsers
	}

	for _, ctr := range ctrResult.Items {
		name := ""
		if len(ctr.Names) > 0 {
			name = strings.TrimPrefix(ctr.Names[0], "/")
		}
		if name == "" {
			name = ctr.ID
		}
		for _, m := range ctr.Mounts {
			if m.Type == "volume" && m.Name != "" {
				volumeUsers[m.Name] = append(volumeUsers[m.Name], name)
			}
		}
	}

	return volumeUsers
}

// ListVolumes returns the list of volumes as raw JSON, enriched with usage info.
func (c *Client) ListVolumes(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.VolumeList(ctx, client.VolumeListOptions{})
	if err != nil {
		return nil, fmt.Errorf("volume list: %w", err)
	}

	volumeUsers := c.collectVolumeUsers(ctx)

	type volumeWithUsage struct {
		volume.Volume
		UsedBy []string `json:"UsedBy"`
	}
	enriched := make([]volumeWithUsage, 0, len(result.Items))
	for _, v := range result.Items {
		vwu := volumeWithUsage{Volume: v}
		if users, ok := volumeUsers[v.Name]; ok {
			vwu.UsedBy = users
		}
		enriched = append(enriched, vwu)
	}

	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal volumes: %w", err)
	}
	return data, nil
}

// InspectVolume returns a single volume as raw JSON, enriched with usage info.
func (c *Client) InspectVolume(ctx context.Context, name string) (json.RawMessage, error) {
	result, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("volume inspect: %w", err)
	}
	type volumeWithUsage struct {
		volume.Volume
		UsedBy []string `json:"UsedBy"`
	}
	enriched := volumeWithUsage{Volume: result.Volume}
	if users, ok := c.collectVolumeUsers(ctx)[result.Volume.Name]; ok {
		enriched.UsedBy = users
	}
	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal volume: %w", err)
	}
	return data, nil
}

// RenameVolume emulates rename by creating a new volume, copying contents, then removing the old volume.
func (c *Client) RenameVolume(ctx context.Context, name string, newName string) error {
	if strings.TrimSpace(name) == "" || strings.TrimSpace(newName) == "" {
		return fmt.Errorf("source and target volume names are required")
	}
	if name == newName {
		return nil
	}
	if used, err := c.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot be renamed", name)
	}

	source, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("volume inspect: %w", err)
	}
	if _, err := c.cli.VolumeInspect(ctx, newName, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("target volume %q already exists", newName)
	}

	if err := c.CreateVolume(ctx, newName, source.Volume.Driver, source.Volume.Labels); err != nil {
		return err
	}
	cleanupTarget := true
	defer func() {
		if cleanupTarget {
			_, _ = c.cli.VolumeRemove(context.Background(), newName, client.VolumeRemoveOptions{Force: true})
		}
	}()

	if err := CopyVolumeContents(ctx, c, name, newName); err != nil {
		return err
	}
	if err := c.RemoveVolume(ctx, name, false); err != nil {
		return err
	}
	cleanupTarget = false
	return nil
}

// UpdateVolumeLabels recreates an unused volume with new labels while preserving its contents.
func (c *Client) UpdateVolumeLabels(ctx context.Context, name string, labels map[string]string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("volume name is required")
	}
	if used, err := c.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot update labels", name)
	}

	source, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("volume inspect: %w", err)
	}

	nextLabels := maps.Clone(labels)
	if nextLabels == nil {
		nextLabels = map[string]string{}
	}
	currentLabels := maps.Clone(source.Volume.Labels)
	if currentLabels == nil {
		currentLabels = map[string]string{}
	}
	for _, key := range []string{managedVolumeLabel, managedVolumeOriginLabel} {
		if supplied, ok := nextLabels[key]; ok && supplied != currentLabels[key] {
			return fmt.Errorf("label %q is reserved for Gateway-managed volumes", key)
		}
		if current, ok := currentLabels[key]; ok {
			nextLabels[key] = current
		} else {
			delete(nextLabels, key)
		}
	}
	if maps.Equal(currentLabels, nextLabels) {
		return nil
	}

	tempName := fmt.Sprintf("gateway-labels-%d", time.Now().UnixNano())
	if err := c.CreateVolume(ctx, tempName, source.Volume.Driver, source.Volume.Labels); err != nil {
		return err
	}
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			_, _ = c.cli.VolumeRemove(context.Background(), tempName, client.VolumeRemoveOptions{Force: true})
		}
	}()

	if err := CopyVolumeContents(ctx, c, name, tempName); err != nil {
		return err
	}
	if err := c.RemoveVolume(ctx, name, false); err != nil {
		return err
	}
	if err := c.CreateVolume(ctx, name, source.Volume.Driver, nextLabels); err != nil {
		if restoreErr := c.restoreVolumeFromTemp(name, tempName, source.Volume.Driver, source.Volume.Labels); restoreErr != nil {
			cleanupTemp = false
			return fmt.Errorf("volume label update failed: %w; restore failed and original data is preserved in temporary volume %q: %v", err, tempName, restoreErr)
		}
		return err
	}
	if err := CopyVolumeContents(ctx, c, tempName, name); err != nil {
		cleanupTemp = false
		return fmt.Errorf("copy volume contents: %w; original data is preserved in temporary volume %q", err, tempName)
	}
	if err := c.RemoveVolume(ctx, tempName, false); err != nil {
		return err
	}
	cleanupTemp = false
	return nil
}

func (c *Client) restoreVolumeFromTemp(name string, tempName string, driver string, labels map[string]string) error {
	ctx := context.Background()
	if err := c.CreateVolume(ctx, name, driver, labels); err != nil {
		return err
	}
	if err := CopyVolumeContents(ctx, c, tempName, name); err != nil {
		return err
	}
	return nil
}

func (c *Client) volumeInUse(ctx context.Context, name string) (bool, error) {
	containers, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return false, fmt.Errorf("container list: %w", err)
	}
	for _, ctr := range containers.Items {
		for _, m := range ctr.Mounts {
			if m.Type == "volume" && m.Name == name {
				return true, nil
			}
		}
	}
	return false, nil
}

// CreateVolume creates a named volume with the given driver and labels.
func (c *Client) CreateVolume(ctx context.Context, name string, driver string, labels map[string]string) error {
	opts := client.VolumeCreateOptions{
		Name:   name,
		Labels: labels,
	}
	if driver != "" {
		opts.Driver = driver
	}
	_, err := c.cli.VolumeCreate(ctx, opts)
	if err != nil {
		return fmt.Errorf("volume create: %w", err)
	}
	return nil
}

// CreateManagedVolume creates a new Gateway-owned volume without adopting an
// existing Docker volume with the same name. Docker's volume-create API is
// idempotent by name, so the explicit inspection and serialized create prevent
// a create request from silently claiming pre-existing data.
func (c *Client) CreateManagedVolume(ctx context.Context, name string) error {
	c.managedVolumeCreateMutex.Lock()
	defer c.managedVolumeCreateMutex.Unlock()

	if _, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("volume %q already exists", name)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check existing volume %q: %w", name, err)
	}

	labels := map[string]string{
		managedVolumeLabel:       "true",
		managedVolumeOriginLabel: "created",
	}
	result, err := c.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name:   name,
		Driver: "local",
		Labels: labels,
	})
	if err != nil {
		return fmt.Errorf("volume create: %w", err)
	}
	if result.Volume.Labels[managedVolumeLabel] != labels[managedVolumeLabel] ||
		result.Volume.Labels[managedVolumeOriginLabel] != labels[managedVolumeOriginLabel] {
		return fmt.Errorf("volume %q appeared concurrently and was left unchanged", name)
	}
	return nil
}

// RemoveVolume removes a volume by name.
func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	_, err := c.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: force})
	if err != nil {
		return fmt.Errorf("volume remove: %w", err)
	}
	return nil
}

// ── Network Operations ────────────────────────────────────────────

// ListNetworks returns the list of networks as raw JSON, with Containers populated.
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
func (c *Client) ContainerName(ctx context.Context, containerID string) (string, error) {
	result, err := c.cli.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect container: %w", err)
	}
	name := strings.TrimPrefix(result.Container.Name, "/")
	if name == "" {
		name = result.Container.ID[:12]
	}
	return name, nil
}

// resolveRegistryAuth determines the registry auth string for the given image
// reference using the provided credentials map (registry URL -> base64 auth).
func resolveRegistryAuth(imageRef string, registryCreds map[string]string) string {
	if len(registryCreds) == 0 {
		return ""
	}
	named, err := reference.ParseNormalizedNamed(imageRef)
	if err != nil {
		return ""
	}
	domain := reference.Domain(named)
	if auth, ok := registryCreds[domain]; ok {
		return auth
	}
	return ""
}

// parseDockerLogs reads Docker multiplexed log output and strips the
// 8-byte header from each frame. Each frame has:
//
//	[1 byte stream type][3 bytes padding][4 bytes big-endian size][payload]
func parseDockerLogs(reader io.Reader) ([]string, error) {
	return parseDockerLogsBounded(reader, 0, maxDockerLogReadBytes)
}

func parseDockerLogsBounded(reader io.Reader, maxLines int, maxBytes int64) ([]string, error) {
	var lines []string
	header := make([]byte, 8)
	var readBytes int64

	for {
		_, err := io.ReadFull(reader, header)
		if err == io.EOF {
			break
		}
		if err != nil {
			// If we get unexpected EOF, the stream might be from a TTY container
			// which doesn't use multiplexed format. Fall back to line-based reading.
			break
		}

		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		readBytes += int64(size)
		if maxBytes > 0 && readBytes > maxBytes {
			return nil, errDockerLogsTooLarge
		}
		if size > maxDockerLogLineBytes {
			return nil, fmt.Errorf("docker log frame exceeds safety limit: %d bytes", size)
		}

		payload := make([]byte, size)
		_, err = io.ReadFull(reader, payload)
		if err != nil {
			break
		}

		// Split payload into lines (a frame may contain multiple lines)
		scanner := bufio.NewScanner(strings.NewReader(string(payload)))
		scanner.Buffer(make([]byte, 0, 64*1024), maxDockerLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				lines = append(lines, line)
				if maxLines > 0 && len(lines) > maxLines {
					copy(lines, lines[len(lines)-maxLines:])
					lines = lines[:maxLines]
				}
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("scan docker logs: %w", err)
		}
	}

	return lines, nil
}
