package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"google.golang.org/protobuf/proto"
)

const (
	proxySecureLinkOwnerKind     = "proxy_host_secure_link"
	secureLinkConnectorName      = "gateway-secure-link-connector"
	secureLinkManagementNetwork  = "gateway-secure-links"
	secureLinkControlSocket      = "/run/gateway/secure-link.sock"
	secureLinkConnectorMemory    = 128 * 1024 * 1024
	secureLinkConnectorNanoCPUs  = 250_000_000
	secureLinkConnectorPidsLimit = int64(128)
	developmentSecureLinkImage   = "gateway-secure-link-connector:dev"
	secureLinkConnectorPathEnv   = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	secureLinkRecoveryWindow     = time.Second
)

var immutableConnectorImagePattern = regexp.MustCompile(`^.+@sha256:[0-9a-f]{64}$`)
var proxySecureLinkIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var errSecureLinkTargetUnavailable = errors.New("target container is unavailable")

type dockerSecureLinkManager struct {
	mu           sync.Mutex
	plugin       *DockerPlugin
	socketPath   string
	bindings     map[string]dockerSecureLinkBinding
	attached     map[string]struct{}
	connectorID  string
	managementIP string

	recoveryMu sync.Mutex
	recovery   *dockerSecureLinkRecovery
}

type dockerSecureLinkRecovery struct {
	done        chan struct{}
	err         error
	completedAt time.Time
}

type dockerSecureLinkBinding struct {
	generation      uint64
	port            uint16
	targetContainer string
	targetNetwork   string
	targetHost      string
}

type dockerSecureLinkStatus struct {
	LinkID        string `json:"linkId"`
	Generation    uint64 `json:"generation"`
	Port          uint16 `json:"port"`
	TargetNetwork string `json:"targetNetwork"`
}

type resolvedSecureLinkTarget struct {
	binding *pb.ProxySecureLinkBinding
	host    string
	network string
}

func newDockerSecureLinkManager(plugin *DockerPlugin) (*dockerSecureLinkManager, error) {
	directory := filepath.Join(plugin.cfg.StateDir, "secure-link-connector")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return nil, err
	}
	if err := os.Chown(directory, 65532, 65532); err != nil {
		return nil, fmt.Errorf("secure-link control directory ownership: %w", err)
	}
	return &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(directory, "secure-link.sock"),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}, nil
}

func (m *dockerSecureLinkManager) sync(command *pb.SyncProxySecureLinksCommand) ([]dockerSecureLinkStatus, error) {
	return m.syncWithPersistence(command, nil, nil)
}

func (m *dockerSecureLinkManager) syncWithPersistence(
	command *pb.SyncProxySecureLinksCommand,
	stage func(*pb.SyncProxySecureLinksCommand) error,
	commit func(*pb.SyncProxySecureLinksCommand) error,
) ([]dockerSecureLinkStatus, error) {
	if command == nil {
		return nil, errors.New("proxy secure-link bindings are required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	bindings := append([]*pb.ProxySecureLinkBinding(nil), command.Bindings...)
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].LinkId < bindings[j].LinkId })
	if len(bindings) == 0 {
		candidate := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
		if stage != nil {
			if err := stage(candidate); err != nil {
				return nil, err
			}
		}
		if err := m.removeConnector(context.Background()); err != nil {
			m.failClosed(context.Background())
			return nil, err
		}
		if commit != nil {
			if err := commit(candidate); err != nil {
				return nil, err
			}
		}
		return []dockerSecureLinkStatus{}, nil
	}

	image := bindings[0].ConnectorImage
	if image != developmentSecureLinkImage && !immutableConnectorImagePattern.MatchString(image) {
		return nil, errors.New("secure-link connector image must use an immutable sha256 digest")
	}
	seen := map[string]struct{}{}
	for _, binding := range bindings {
		if binding.Role != "target" || !proxySecureLinkIDPattern.MatchString(binding.LinkId) || binding.TargetPort == 0 || binding.TargetPort > 65535 || binding.TargetContainer == "" || binding.ConnectorImage != image {
			return nil, errors.New("invalid proxy secure-link target binding")
		}
		if _, duplicate := seen[binding.LinkId]; duplicate {
			return nil, fmt.Errorf("duplicate proxy secure-link binding %s", binding.LinkId)
		}
		seen[binding.LinkId] = struct{}{}
		if current, exists := m.bindings[binding.LinkId]; exists && binding.Generation < current.generation {
			return nil, fmt.Errorf("stale generation for proxy secure-link %s", binding.LinkId)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	desiredNetworks := map[string]struct{}{}
	resolved := make([]resolvedSecureLinkTarget, 0, len(bindings))
	for _, binding := range bindings {
		targetIP, networkName, err := m.resolveTarget(
			ctx,
			binding.TargetContainer,
			binding.TargetNetwork,
			binding.TargetHost,
			binding.AllowNetworkReselection,
		)
		if err != nil {
			return nil, fmt.Errorf("resolve secure-link %s: %w", binding.LinkId, err)
		}
		desiredNetworks[networkName] = struct{}{}
		resolved = append(resolved, resolvedSecureLinkTarget{binding: binding, host: targetIP, network: networkName})
	}
	// Resolve and validate the complete target set before the write-ahead save,
	// so an invalid command cannot poison restart recovery for existing links.
	candidate := normalizeResolvedTargetBindings(command, resolved)
	if stage != nil {
		if err := stage(candidate); err != nil {
			return nil, err
		}
	}
	if err := m.ensureConnector(ctx, image); err != nil {
		m.failClosed(context.Background())
		return nil, err
	}
	for networkName := range desiredNetworks {
		if _, attached := m.attached[networkName]; attached {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkConnect(ctx, networkName, mobyclient.NetworkConnectOptions{Container: m.connectorID}); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
			m.failClosed(context.Background())
			return nil, fmt.Errorf("attach secure-link connector to %s: %w", networkName, err)
		}
		m.attached[networkName] = struct{}{}
	}

	configs := make([]securelink.BindingConfig, 0, len(bindings))
	resolvedByID := make(map[string]resolvedSecureLinkTarget, len(resolved))
	for _, target := range resolved {
		binding := target.binding
		resolvedByID[binding.LinkId] = target
		configs = append(configs, securelink.BindingConfig{
			ID: binding.LinkId, Generation: binding.Generation, ListenHost: m.managementIP,
			TargetHost: target.host, TargetPort: uint16(binding.TargetPort),
		})
	}
	response, err := securelink.Sync(ctx, m.socketPath, configs)
	if err != nil {
		m.failClosed(context.Background())
		return nil, err
	}
	next := make(map[string]dockerSecureLinkBinding, len(response.Bindings))
	statuses := make([]dockerSecureLinkStatus, 0, len(response.Bindings))
	for _, status := range response.Bindings {
		target, ok := resolvedByID[status.ID]
		if !ok {
			m.failClosed(context.Background())
			return nil, fmt.Errorf("secure-link connector returned unknown binding %s", status.ID)
		}
		next[status.ID] = dockerSecureLinkBinding{
			generation: status.Generation, port: status.Port,
			targetContainer: target.binding.TargetContainer,
			targetNetwork:   target.network, targetHost: target.host,
		}
		statuses = append(statuses, dockerSecureLinkStatus{LinkID: status.ID, Generation: status.Generation, Port: status.Port, TargetNetwork: target.network})
	}
	if len(next) != len(bindings) {
		m.failClosed(context.Background())
		return nil, errors.New("secure-link connector returned an incomplete binding set")
	}
	m.bindings = next
	for networkName := range m.attached {
		if _, keep := desiredNetworks[networkName]; keep {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, networkName, mobyclient.NetworkDisconnectOptions{Container: m.connectorID, Force: true}); err != nil && !isNotFoundErr(err) {
			m.failClosed(context.Background())
			return nil, fmt.Errorf("detach secure-link connector from %s: %w", networkName, err)
		}
		delete(m.attached, networkName)
	}
	if commit != nil {
		if err := commit(candidate); err != nil {
			// The live apply cannot be treated as accepted when its committed
			// snapshot failed. Refuse new tunnels and best-effort remove the
			// connector bindings until control-plane reconciliation retries.
			m.failClosed(context.Background())
			return nil, fmt.Errorf("commit proxy secure-link state: %w", err)
		}
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].LinkID < statuses[j].LinkID })
	return statuses, nil
}

// failClosed prevents a partially applied connector state from accepting new
// relay streams. The committed snapshot remains available for a clean retry.
func (m *dockerSecureLinkManager) failClosed(ctx context.Context) {
	m.bindings = map[string]dockerSecureLinkBinding{}
	cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _ = securelink.Sync(cleanupCtx, m.socketPath, nil)
}

func (m *dockerSecureLinkManager) ensureConnector(ctx context.Context, image string) error {
	managementNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{})
	if err == nil && !validSecureLinkManagementNetwork(managementNetwork.Network) {
		return errors.New("refusing to use a non-managed or externally reachable secure-link management network")
	}
	if err != nil {
		if !isNotFoundErr(err) {
			return fmt.Errorf("inspect secure-link management network: %w", err)
		}
		if _, err := m.plugin.client.cli.NetworkCreate(ctx, secureLinkManagementNetwork, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Internal: true, Labels: map[string]string{"wiolett.gateway.managed": "secure-link"},
		}); err != nil {
			return fmt.Errorf("create secure-link management network: %w", err)
		}
	}

	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkConnectorName, mobyclient.ContainerInspectOptions{})
	if err == nil && !validSecureLinkConnector(inspect.Container, image, filepath.Dir(m.socketPath)) {
		if !ownedSecureLinkConnector(inspect.Container) {
			return errors.New("refusing to replace a non-managed container using the secure-link connector name")
		}
		_, err = m.plugin.client.cli.ContainerRemove(ctx, secureLinkConnectorName, mobyclient.ContainerRemoveOptions{Force: true})
		if err != nil {
			return fmt.Errorf("replace unsafe or outdated secure-link connector: %w", err)
		}
		err = errors.New("connector configuration changed")
	}
	if err != nil {
		if !isNotFoundErr(err) && err.Error() != "connector configuration changed" {
			return fmt.Errorf("inspect secure-link connector: %w", err)
		}
		if image != developmentSecureLinkImage {
			if err := m.plugin.client.pullImageIfNeeded(ctx, image, ""); err != nil {
				return fmt.Errorf("pull secure-link connector: %w", err)
			}
		}
		_ = os.Remove(m.socketPath)
		pids := secureLinkConnectorPidsLimit
		created, createErr := m.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
			Config: &container.Config{
				Image: image, User: "65532:65532",
				Env:    []string{"GATEWAY_SECURE_LINK_SOCKET=" + secureLinkControlSocket},
				Labels: map[string]string{"wiolett.gateway.managed": "secure-link-connector"},
			},
			HostConfig: &container.HostConfig{
				Binds:          []string{filepath.Dir(m.socketPath) + ":/run/gateway"},
				ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
				Resources:     container.Resources{Memory: secureLinkConnectorMemory, NanoCPUs: secureLinkConnectorNanoCPUs, PidsLimit: &pids},
			},
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{secureLinkManagementNetwork: {}}},
			Name:             secureLinkConnectorName,
		})
		if createErr != nil {
			return fmt.Errorf("create secure-link connector: %w", createErr)
		}
		if _, startErr := m.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); startErr != nil {
			return fmt.Errorf("start secure-link connector: %w", startErr)
		}
		inspect, err = m.plugin.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return fmt.Errorf("inspect created secure-link connector: %w", err)
		}
	} else if inspect.Container.State == nil || !inspect.Container.State.Running {
		if _, err := m.plugin.client.cli.ContainerStart(ctx, inspect.Container.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return fmt.Errorf("start existing secure-link connector: %w", err)
		}
		inspect, err = m.plugin.client.cli.ContainerInspect(ctx, inspect.Container.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return err
		}
	}
	if inspect.Container.NetworkSettings == nil {
		return errors.New("secure-link connector network settings are unavailable")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[secureLinkManagementNetwork]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return errors.New("secure-link connector management address is unavailable")
	}
	m.connectorID = inspect.Container.ID
	m.managementIP = endpoint.IPAddress.String()
	m.attached = map[string]struct{}{}
	for name := range inspect.Container.NetworkSettings.Networks {
		if name != secureLinkManagementNetwork {
			m.attached[name] = struct{}{}
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(m.socketPath); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("secure-link connector control socket did not become ready")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func validSecureLinkManagementNetwork(inspect network.Inspect) bool {
	return inspect.Driver == "bridge" && inspect.Internal && !inspect.Ingress && !inspect.ConfigOnly &&
		inspect.Labels["wiolett.gateway.managed"] == "secure-link"
}

func validSecureLinkConnector(inspect container.InspectResponse, image, controlDirectory string) bool {
	return inspect.Config != nil && inspect.Config.Image == image && managedSecureLinkConnector(inspect, controlDirectory)
}

func ownedSecureLinkConnector(inspect container.InspectResponse) bool {
	return inspect.Config != nil && inspect.Config.Labels["wiolett.gateway.managed"] == "secure-link-connector"
}

func managedSecureLinkConnector(inspect container.InspectResponse, controlDirectory string) bool {
	config := inspect.Config
	host := inspect.HostConfig
	if config == nil || host == nil ||
		(config.Image != developmentSecureLinkImage && !immutableConnectorImagePattern.MatchString(config.Image)) ||
		config.User != "65532:65532" ||
		config.Labels["wiolett.gateway.managed"] != "secure-link-connector" ||
		!validSecureLinkConnectorEnv(config.Env) ||
		len(config.ExposedPorts) != 0 || host.Privileged || host.PublishAllPorts || !host.ReadonlyRootfs ||
		len(host.CapAdd) != 0 || !containsFold(host.CapDrop, "ALL") ||
		(!containsFold(host.SecurityOpt, "no-new-privileges") && !containsFold(host.SecurityOpt, "no-new-privileges:true")) ||
		string(host.NetworkMode) == "host" || len(host.PortBindings) != 0 ||
		len(host.Binds) != 1 || host.Binds[0] != controlDirectory+":/run/gateway" ||
		host.RestartPolicy.Name != "unless-stopped" || host.Resources.Memory != secureLinkConnectorMemory ||
		host.Resources.NanoCPUs != secureLinkConnectorNanoCPUs || host.Resources.PidsLimit == nil ||
		*host.Resources.PidsLimit != secureLinkConnectorPidsLimit {
		return false
	}
	return inspect.NetworkSettings != nil && len(inspect.NetworkSettings.Ports) == 0
}

func validSecureLinkConnectorEnv(values []string) bool {
	socket := "GATEWAY_SECURE_LINK_SOCKET=" + secureLinkControlSocket
	seenSocket := false
	seenPath := false
	for _, value := range values {
		switch value {
		case socket:
			if seenSocket {
				return false
			}
			seenSocket = true
		case secureLinkConnectorPathEnv:
			if seenPath {
				return false
			}
			seenPath = true
		default:
			return false
		}
	}
	return seenSocket
}

func containsFold(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(value, expected) {
			return true
		}
	}
	return false
}

func (m *dockerSecureLinkManager) resolveTarget(
	ctx context.Context,
	containerName, networkName, expectedHost string,
	allowNetworkReselection bool,
) (string, string, error) {
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.NetworkSettings == nil {
		return "", "", errSecureLinkTargetUnavailable
	}
	primary := ""
	if inspect.Container.HostConfig != nil {
		primary = string(inspect.Container.HostConfig.NetworkMode)
	}
	networkName, err = selectSecureLinkTargetNetwork(
		inspect.Container.NetworkSettings.Networks,
		primary,
		networkName,
		allowNetworkReselection,
	)
	if err != nil {
		return "", "", err
	}
	endpoint := inspect.Container.NetworkSettings.Networks[networkName]
	actual := endpoint.IPAddress.String()
	if expectedHost != "" && expectedHost != actual {
		return "", "", errors.New("target address changed during reconciliation")
	}
	return actual, networkName, nil
}

func selectSecureLinkTargetNetwork(
	networks map[string]*network.EndpointSettings,
	primary, requested string,
	allowReselection bool,
) (string, error) {
	valid := func(name string) bool {
		endpoint := networks[name]
		return name != "" && name != secureLinkManagementNetwork && endpoint != nil && endpoint.IPAddress.IsValid()
	}
	if valid(requested) {
		return requested, nil
	}
	if requested != "" && !allowReselection {
		return "", errors.New("target container is not attached to the selected network")
	}
	if valid(primary) {
		return primary, nil
	}
	names := make([]string, 0, len(networks))
	for name := range networks {
		if valid(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "", errors.New("target container has no usable network")
	}
	return names[0], nil
}

func (m *dockerSecureLinkManager) dial(ctx context.Context, linkID string) (net.Conn, error) {
	return dialWithOneRestore(ctx, linkID, m.dialCurrent, func(firstErr error) error {
		return m.restoreBindingsCoalesced(!errors.Is(firstErr, errSecureLinkTargetUnavailable))
	})
}

func (m *dockerSecureLinkManager) restoreBindingsCoalesced(bypassCompleted bool) error {
	return m.restoreCoalesced(m.restoreBindings, bypassCompleted)
}

func (m *dockerSecureLinkManager) restoreCoalesced(restore func() error, bypassCompleted bool) error {
	m.recoveryMu.Lock()
	if current := m.recovery; current != nil {
		if !current.completedAt.IsZero() {
			if !bypassCompleted && time.Since(current.completedAt) < secureLinkRecoveryWindow {
				err := current.err
				m.recoveryMu.Unlock()
				return err
			}
			m.recovery = nil
		} else {
			m.recoveryMu.Unlock()
			<-current.done
			return current.err
		}
	}
	current := &dockerSecureLinkRecovery{done: make(chan struct{})}
	m.recovery = current
	m.recoveryMu.Unlock()

	err := restore()
	m.recoveryMu.Lock()
	current.err = err
	current.completedAt = time.Now()
	close(current.done)
	m.recoveryMu.Unlock()
	return err
}

func (m *dockerSecureLinkManager) restoreBindings() error {
	if m.plugin.secureLinkState == nil {
		return errors.New("proxy secure-link state is unavailable")
	}
	restored := m.plugin.secureLinkState.Get()
	if len(restored.Bindings) == 0 {
		return errors.New("proxy secure-link desired state is empty")
	}
	if _, err := m.sync(restored); err != nil {
		return fmt.Errorf("restore proxy secure-link bindings after connector restart: %w", err)
	}
	return nil
}

func dialWithOneRestore(
	ctx context.Context,
	linkID string,
	dial func(context.Context, string) (net.Conn, error),
	restore func(error) error,
) (net.Conn, error) {
	connection, firstErr := dial(ctx, linkID)
	if firstErr == nil {
		return connection, nil
	}
	if err := restore(firstErr); err != nil {
		return nil, fmt.Errorf("%v; recovery failed: %w", firstErr, err)
	}
	return dial(ctx, linkID)
}

func (m *dockerSecureLinkManager) dialCurrent(ctx context.Context, linkID string) (net.Conn, error) {
	m.mu.Lock()
	binding, ok := m.bindings[linkID]
	host := m.managementIP
	m.mu.Unlock()
	if !ok || host == "" || binding.port == 0 {
		return nil, errors.New("proxy secure-link binding is unavailable")
	}
	actualHost, actualNetwork, err := m.resolveTarget(
		ctx, binding.targetContainer, binding.targetNetwork, binding.targetHost, false,
	)
	if err != nil || actualHost != binding.targetHost || actualNetwork != binding.targetNetwork {
		if err == nil {
			err = errors.New("target identity changed")
		}
		return nil, fmt.Errorf("validate proxy secure-link target: %w", err)
	}
	return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprintf("%d", binding.port)))
}

func (m *dockerSecureLinkManager) removeConnector(ctx context.Context) error {
	connectorID := m.connectorID
	if connectorID == "" {
		inspect, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkConnectorName, mobyclient.ContainerInspectOptions{})
		if err == nil {
			if !managedSecureLinkConnector(inspect.Container, filepath.Dir(m.socketPath)) {
				return errors.New("refusing to remove a non-managed container using the secure-link connector name")
			}
			connectorID = inspect.Container.ID
		} else if !isNotFoundErr(err) {
			return fmt.Errorf("inspect secure-link connector for cleanup: %w", err)
		}
	}
	if connectorID != "" {
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, connectorID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove secure-link connector: %w", err)
		}
	}
	managementNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{})
	if err == nil {
		if !validSecureLinkManagementNetwork(managementNetwork.Network) {
			return errors.New("refusing to remove a non-managed secure-link management network")
		}
		if _, err := m.plugin.client.cli.NetworkRemove(ctx, managementNetwork.Network.ID, mobyclient.NetworkRemoveOptions{}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove secure-link management network: %w", err)
		}
	} else if !isNotFoundErr(err) {
		return fmt.Errorf("inspect secure-link management network for cleanup: %w", err)
	}
	_ = os.Remove(m.socketPath)
	m.connectorID = ""
	m.managementIP = ""
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.attached = map[string]struct{}{}
	return nil
}

func (p *DockerPlugin) SyncProxySecureLinks(command *pb.SyncProxySecureLinksCommand) (string, error) {
	if p.cfg.Docker.Mode == "databases" || p.secureLinks == nil {
		return "", errors.New("proxy secure links require a general Docker daemon")
	}
	statuses, err := p.secureLinks.syncWithPersistence(command, p.secureLinkState.Stage, p.secureLinkState.Commit)
	if err != nil {
		return "", err
	}
	detail, err := json.Marshal(map[string]any{"bindings": statuses})
	return string(detail), err
}

func normalizeResolvedTargetBindings(
	command *pb.SyncProxySecureLinksCommand,
	resolved []resolvedSecureLinkTarget,
) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	networks := make(map[string]string, len(resolved))
	for _, target := range resolved {
		networks[target.binding.LinkId] = target.network
	}
	for _, binding := range normalized.Bindings {
		binding.TargetNetwork = networks[binding.LinkId]
		binding.TargetHost = ""
	}
	return normalized
}

func normalizeTargetBindings(command *pb.SyncProxySecureLinksCommand, statuses []dockerSecureLinkStatus) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	networks := make(map[string]string, len(statuses))
	for _, status := range statuses {
		networks[status.LinkID] = status.TargetNetwork
	}
	for _, binding := range normalized.Bindings {
		binding.TargetNetwork = networks[binding.LinkId]
		binding.TargetHost = ""
	}
	return normalized
}
