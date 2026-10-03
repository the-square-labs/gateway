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
	"sync/atomic"
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
	secureLinkConnectorMemory    = 128 * 1024 * 1024
	secureLinkConnectorNanoCPUs  = 250_000_000
	secureLinkConnectorPidsLimit = int64(128)
	developmentSecureLinkImage   = "gateway-secure-link-connector:dev"
	secureLinkConnectorPathEnv   = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	secureLinkRecoveryWindow     = time.Second
)

// secureLinkConnectorRetireLimit bounds how long a replaced connector keeps
// the tunnels that are busy (a request in flight, a WebSocket); a variable for
// tests.
var secureLinkConnectorRetireLimit = 10 * time.Minute

const secureLinkConnectorRetireTick = 100 * time.Millisecond

// secureLinkConnectorSlots are the two connector containers that take turns:
// a new connector image starts in the other slot while the serving one keeps
// forwarding. Both share the control directory, each with its own socket.
var secureLinkConnectorSlots = [2]struct{ name, socket string }{
	{name: secureLinkConnectorName, socket: "secure-link.sock"},
	{name: secureLinkConnectorName + "-next", socket: "secure-link-next.sock"},
}

var immutableConnectorImagePattern = regexp.MustCompile(`^.+@sha256:[0-9a-f]{64}$`)
var officialConnectorReleaseTagPattern = regexp.MustCompile(`^ghcr\.io/the-square-labs/gateway/secure-link-connector:v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?-relay$`)
var proxySecureLinkIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var errSecureLinkTargetUnavailable = errors.New("target container is unavailable")

// secureLinkTargetUnknownError is a target check dockerd did not answer: the
// target may run or not. Every caller reads it as errSecureLinkTargetUnavailable
// (the same text, which Gateway parses); apply keeps a link bound to that same
// target instead (B-24).
type secureLinkTargetUnknownError struct{ cause error }

func (e secureLinkTargetUnknownError) Error() string { return errSecureLinkTargetUnavailable.Error() }
func (e secureLinkTargetUnknownError) Unwrap() error { return e.cause }
func (e secureLinkTargetUnknownError) Is(target error) bool {
	return target == errSecureLinkTargetUnavailable
}

// secureLinkConnectorUnchangedError is an ensureConnector failure before it
// changed anything (dockerd did not answer its first checks): the connector
// and its bindings are as they were, and apply leaves them serving (B-24).
type secureLinkConnectorUnchangedError struct{ err error }

func (e secureLinkConnectorUnchangedError) Error() string { return e.err.Error() }
func (e secureLinkConnectorUnchangedError) Unwrap() error { return e.err }

type dockerSecureLinkManager struct {
	mu         sync.Mutex
	plugin     *DockerPlugin
	socketPath string
	bindings   map[string]dockerSecureLinkBinding
	// unbound are committed links left out of the connector because their
	// target was unavailable (a dormant standby, or a stopped target on
	// restore); a later restore binds them once the target runs.
	unbound      map[string]struct{}
	attached     map[string]struct{}
	connectorID  string
	managementIP string
	// slot is the secureLinkConnectorSlots entry of connectorID.
	slot int
	// resolveTargetForDial replaces resolveTarget in dial validation (tests).
	resolveTargetForDial func(ctx context.Context, containerName, networkName, expectedHost string, allowNetworkReselection bool) (string, string, error)

	recoveryMu sync.Mutex
	recovery   *dockerSecureLinkRecovery

	// dockerQuietUntil: dockerd did not answer a dial's target validation; until
	// then dials skip it (see validateDialTarget).
	dockerQuietMu    sync.Mutex
	dockerQuietUntil time.Time

	// validated and validating share a link's target check between the dials
	// of a moment (see validateDialTarget); guarded by validationMu.
	validationMu sync.Mutex
	validated    map[string]dialValidation
	validating   map[string]*dialValidation

	// view is what dials read: a copy of bindings, unbound and managementIP
	// published after every change. apply holds mu across dockerd calls, and a
	// dial must not wait for them (B-8, D5).
	viewMu sync.RWMutex
	view   *dockerSecureLinkView

	// probeRestoreAt is when a readiness probe last restored bindings (unix ns).
	probeRestoreAt atomic.Int64
}

type dockerSecureLinkView struct {
	bindings     map[string]dockerSecureLinkBinding
	unbound      map[string]struct{}
	managementIP string
	connectorID  string
}

// publishViewLocked publishes the binding state for dials. Callers hold mu.
// The maps are replaced, never changed in place, so the view may share them.
func (m *dockerSecureLinkManager) publishViewLocked() {
	m.viewMu.Lock()
	m.view = &dockerSecureLinkView{bindings: m.bindings, unbound: m.unbound, managementIP: m.managementIP, connectorID: m.connectorID}
	m.viewMu.Unlock()
}

func (m *dockerSecureLinkManager) currentView() *dockerSecureLinkView {
	m.viewMu.RLock()
	view := m.view
	m.viewMu.RUnlock()
	if view == nil {
		// Built without newDockerSecureLinkManager (tests): read the fields.
		m.mu.Lock()
		view = &dockerSecureLinkView{bindings: m.bindings, unbound: m.unbound, managementIP: m.managementIP, connectorID: m.connectorID}
		m.mu.Unlock()
	}
	return view
}

// dialState returns a link's binding for a dial without waiting for apply.
func (m *dockerSecureLinkManager) dialState(linkID string) (binding dockerSecureLinkBinding, bound, unbound bool, host string) {
	view := m.currentView()
	binding, bound = view.bindings[linkID]
	_, unbound = view.unbound[linkID]
	return binding, bound, unbound, view.managementIP
}

const (
	// secureLinkValidateWait bounds the dockerd call a new tunnel makes to
	// validate its target (B-8, D5): a dial waits at most this long before it
	// uses the target the link is bound to (B-26).
	secureLinkValidateWait = 300 * time.Millisecond
	// secureLinkDockerQuiet is how long dials skip that call after dockerd
	// did not answer it; the first dial after it tries again.
	secureLinkDockerQuiet = 2 * time.Second
	// secureLinkValidateTTL is how long a validated target is trusted by the
	// dials that follow (B-22): every relayed connection used to ask dockerd,
	// which under load queued the connections behind dockerd.
	secureLinkValidateTTL = 2 * time.Second
)

// dialValidation is a target check that ran or runs for one link.
type dialValidation struct {
	binding dockerSecureLinkBinding
	at      time.Time
	done    chan struct{}
	err     error
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
	if runsWithoutRoot() {
		// The connector creates its sockets here through the daemon's group (connectorGroupAdd); setgid gives them
		// that group, so the daemon can connect to them.
		if err := claimConnectorDirectory(directory, 0o770|os.ModeSetgid); err != nil {
			return nil, fmt.Errorf("secure-link control directory: %w", err)
		}
	} else {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return nil, err
		}
		if err := os.Chown(directory, 65532, 65532); err != nil {
			return nil, fmt.Errorf("secure-link control directory ownership: %w", err)
		}
		// A directory a non-root daemon left behind is group-writable for that daemon's user.
		if err := os.Chmod(directory, 0o750); err != nil {
			return nil, fmt.Errorf("secure-link control directory permissions: %w", err)
		}
	}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(directory, "secure-link.sock"),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()
	return manager, nil
}

// restore re-applies the committed bindings after a daemon or connector
// restart. Unlike a Gateway sync it works per binding: a link whose target
// cannot be resolved (a container that is stopped or gone) is left out and
// stays committed, and every other link on the node is bound. A later
// restore, on dial or before a lease holder serves, binds it once it runs.
func (m *dockerSecureLinkManager) restore(command *pb.SyncProxySecureLinksCommand) ([]dockerSecureLinkStatus, error) {
	return m.apply(command, nil, nil, true)
}

// syncWithPersistence applies a Gateway sync: the complete target set must
// resolve (dormant standbys aside) before anything is saved or changed.
func (m *dockerSecureLinkManager) syncWithPersistence(
	command *pb.SyncProxySecureLinksCommand,
	stage func(*pb.SyncProxySecureLinksCommand) error,
	commit func(*pb.SyncProxySecureLinksCommand) error,
) ([]dockerSecureLinkStatus, error) {
	return m.apply(command, stage, commit, false)
}

func (m *dockerSecureLinkManager) apply(
	command *pb.SyncProxySecureLinksCommand,
	stage func(*pb.SyncProxySecureLinksCommand) error,
	commit func(*pb.SyncProxySecureLinksCommand) error,
	perBinding bool,
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
	if !allowedSecureLinkConnectorImage(image) {
		return nil, errors.New("secure-link connector image must use an immutable sha256 digest or an official Gateway Relay release tag")
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
	kept := 0
	resolved, desiredNetworks, skipped, err := resolveSecureLinkTargets(bindings, func(binding *pb.ProxySecureLinkBinding) (string, string, error) {
		host, network, err := m.resolveTarget(ctx, binding.TargetContainer, binding.TargetNetwork, binding.TargetHost, binding.AllowNetworkReselection)
		var unknown secureLinkTargetUnknownError
		if err != nil && errors.As(err, &unknown) {
			if current, ok := m.boundTargetLocked(binding); ok {
				kept++
				return current.targetHost, current.targetNetwork, nil
			}
		}
		return host, network, err
	}, perBinding)
	if err != nil {
		return nil, err
	}
	if kept > 0 && m.plugin != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("dockerd did not answer secure-link target checks; bound links keep their targets", "links", kept)
	}
	unbound := make(map[string]struct{}, len(skipped))
	for _, skip := range skipped {
		unbound[skip.binding.LinkId] = struct{}{}
		// A lease-bound member's container runs only while this node holds the lease.
		if !leaseBoundTarget(skip.binding) && m.plugin != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("proxy secure-link left unbound until its target runs", "link_id", skip.binding.LinkId, "target_container", skip.binding.TargetContainer, "error", skip.err)
		}
	}
	// Resolve and validate the complete target set before the write-ahead save,
	// so an invalid command cannot poison restart recovery for existing links.
	candidate := normalizeResolvedTargetBindings(command, resolved)
	if stage != nil {
		if err := stage(candidate); err != nil {
			return nil, err
		}
	}
	replacement, err := m.ensureConnector(ctx, image)
	if err != nil {
		var unchanged secureLinkConnectorUnchangedError
		if !errors.As(err, &unchanged) {
			m.failClosed(context.Background())
		}
		return nil, err
	}
	// A failure from here on refuses new tunnels until a retry, unless a
	// replacement connector was being bound: then the previous connector
	// keeps serving its links as before.
	fail := func(err error) error {
		if replacement != nil {
			m.abortReplacement(replacement)
		} else {
			m.failClosed(context.Background())
		}
		return err
	}
	for networkName := range desiredNetworks {
		if _, attached := m.attached[networkName]; attached {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkConnect(ctx, networkName, mobyclient.NetworkConnectOptions{Container: m.connectorID}); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
			return nil, fail(fmt.Errorf("attach secure-link connector to %s: %w", networkName, err))
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
		return nil, fail(err)
	}
	next := make(map[string]dockerSecureLinkBinding, len(response.Bindings))
	statuses := make([]dockerSecureLinkStatus, 0, len(response.Bindings))
	for _, status := range response.Bindings {
		target, ok := resolvedByID[status.ID]
		if !ok {
			return nil, fail(fmt.Errorf("secure-link connector returned unknown binding %s", status.ID))
		}
		next[status.ID] = dockerSecureLinkBinding{
			generation: status.Generation, port: status.Port,
			targetContainer: target.binding.TargetContainer,
			targetNetwork:   target.network, targetHost: target.host,
		}
		statuses = append(statuses, dockerSecureLinkStatus{LinkID: status.ID, Generation: status.Generation, Port: status.Port, TargetNetwork: target.network})
	}
	if len(next) != len(resolved) {
		return nil, fail(errors.New("secure-link connector returned an incomplete binding set"))
	}
	m.bindings = next
	m.unbound = unbound
	m.publishViewLocked()
	for networkName := range m.attached {
		if _, keep := desiredNetworks[networkName]; keep {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, networkName, mobyclient.NetworkDisconnectOptions{Container: m.connectorID, Force: true}); err != nil && !isNotFoundErr(err) {
			return nil, fail(fmt.Errorf("detach secure-link connector from %s: %w", networkName, err))
		}
		delete(m.attached, networkName)
	}
	if commit != nil {
		if err := commit(candidate); err != nil {
			// The live apply cannot be treated as accepted when its committed
			// snapshot failed. Refuse new tunnels and best-effort remove the
			// connector bindings until control-plane reconciliation retries.
			return nil, fail(fmt.Errorf("commit proxy secure-link state: %w", err))
		}
	}
	if replacement != nil {
		if m.plugin.logger != nil {
			m.plugin.logger.Info("secure-link connector replaced; the previous one is retired once its tunnels are idle", "image", image)
		}
		m.retireConnector(replacement.previous)
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].LinkID < statuses[j].LinkID })
	return statuses, nil
}

// boundTargetLocked returns the target a link is bound to when the command
// keeps it there: the same container, address and network. dockerd not
// answering a check is no evidence that the target stopped, and only dockerd
// can hand its address to another container (B-8, D5): a sync or restore that
// runs while dockerd is frozen or overloaded must not unbind a serving link
// (B-24). Callers hold mu.
func (m *dockerSecureLinkManager) boundTargetLocked(binding *pb.ProxySecureLinkBinding) (dockerSecureLinkBinding, bool) {
	current, ok := m.bindings[binding.LinkId]
	if !ok || current.targetHost == "" || current.targetContainer != binding.TargetContainer {
		return dockerSecureLinkBinding{}, false
	}
	if binding.TargetHost != "" && binding.TargetHost != current.targetHost {
		return dockerSecureLinkBinding{}, false
	}
	if binding.TargetNetwork != "" && binding.TargetNetwork != current.targetNetwork {
		return dockerSecureLinkBinding{}, false
	}
	return current, true
}

// skippedSecureLinkTarget is a binding left out of the connector.
type skippedSecureLinkTarget struct {
	binding *pb.ProxySecureLinkBinding
	err     error
}

// resolveSecureLinkTargets resolves every target binding. An availability
// member whose container is stopped is left out of the connector, stays in the
// committed state, and is bound by the restore that runs once this node serves
// the lease: a dormant member targets a created, stopped standby (D7), and a
// lease-gated member serves only while its node holds the lease (D8), which
// Gateway learns after the fact. perBinding (restore) leaves out every binding
// whose target does not resolve, so one missing target cannot take the other
// links of the node down with it.
func resolveSecureLinkTargets(
	bindings []*pb.ProxySecureLinkBinding,
	resolve func(*pb.ProxySecureLinkBinding) (string, string, error),
	perBinding bool,
) ([]resolvedSecureLinkTarget, map[string]struct{}, []skippedSecureLinkTarget, error) {
	networks := map[string]struct{}{}
	resolved := make([]resolvedSecureLinkTarget, 0, len(bindings))
	var skipped []skippedSecureLinkTarget
	for _, binding := range bindings {
		host, network, err := resolve(binding)
		if err != nil {
			if perBinding || (errors.Is(err, errSecureLinkTargetUnavailable) && leaseBoundTarget(binding)) {
				skipped = append(skipped, skippedSecureLinkTarget{binding: binding, err: err})
				continue
			}
			return nil, nil, nil, fmt.Errorf("resolve secure-link %s: %w", binding.LinkId, err)
		}
		networks[network] = struct{}{}
		resolved = append(resolved, resolvedSecureLinkTarget{binding: binding, host: host, network: network})
	}
	return resolved, networks, skipped, nil
}

// leaseBoundTarget reports whether a stopped target is expected: the member of
// a standby placement, or of a lease-mode policy, whose container runs only
// while its node holds the data-plane lease.
func leaseBoundTarget(binding *pb.ProxySecureLinkBinding) bool {
	return binding.GetDormant() || binding.GetAvailabilityPolicyId() != ""
}

func allowedSecureLinkConnectorImage(image string) bool {
	return image == developmentSecureLinkImage ||
		immutableConnectorImagePattern.MatchString(image) ||
		officialConnectorReleaseTagPattern.MatchString(image)
}

// failClosed prevents a partially applied connector state from accepting new
// relay streams. The committed snapshot remains available for a clean retry.
func (m *dockerSecureLinkManager) failClosed(ctx context.Context) {
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
	cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _ = securelink.Sync(cleanupCtx, m.socketPath, nil)
}

// ensureConnector makes the connector run the image. A connector that serves
// links and runs another image (the connector image a Relay update promoted)
// is not replaced in place: that left every Secure Link route of the node
// without a connector until the new one was pulled, started and bound (seconds
// of failed requests on every route). The new connector starts
// in the other slot next to it instead; the returned replacement is switched
// to by apply once its links are bound, and the previous connector is retired
// after its tunnels drained.
func (m *dockerSecureLinkManager) ensureConnector(ctx context.Context, image string) (*connectorReplacement, error) {
	managementNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{})
	if err == nil && !validSecureLinkManagementNetwork(managementNetwork.Network) {
		return nil, errors.New("refusing to use a non-managed or externally reachable secure-link management network")
	}
	if err != nil {
		if !isNotFoundErr(err) {
			return nil, secureLinkConnectorUnchangedError{fmt.Errorf("inspect secure-link management network: %w", err)}
		}
		if _, err := m.plugin.client.cli.NetworkCreate(ctx, secureLinkManagementNetwork, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Internal: true, Labels: map[string]string{"wiolett.gateway.managed": "secure-link"},
		}); err != nil {
			return nil, fmt.Errorf("create secure-link management network: %w", err)
		}
	}

	slot, inspect, err := m.findConnector(ctx, image)
	if err != nil {
		return nil, secureLinkConnectorUnchangedError{err}
	}
	controlDirectory := filepath.Dir(m.socketPath)
	if inspect != nil && inspect.Config != nil && inspect.Config.Image != image &&
		managedSecureLinkConnector(*inspect, controlDirectory) && inspect.State != nil && inspect.State.Running &&
		inspect.ID == m.connectorID && len(m.bindings) > 0 {
		return m.startReplacement(ctx, image, slot)
	}
	if inspect != nil && !validSecureLinkConnector(*inspect, image, controlDirectory) {
		if !ownedSecureLinkConnector(*inspect) {
			return nil, errors.New("refusing to replace a non-managed container using the secure-link connector name")
		}
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspect.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil {
			return nil, fmt.Errorf("replace unsafe or outdated secure-link connector: %w", err)
		}
		inspect = nil
	}
	if inspect == nil {
		if inspect, err = m.createConnector(ctx, image, slot); err != nil {
			return nil, err
		}
	} else if inspect.State == nil || !inspect.State.Running {
		if _, err := m.plugin.client.cli.ContainerStart(ctx, inspect.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return nil, fmt.Errorf("start existing secure-link connector: %w", err)
		}
		started, err := m.plugin.client.cli.ContainerInspect(ctx, inspect.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return nil, err
		}
		inspect = &started.Container
	}
	runtime, err := connectorRuntimeOf(*inspect, slot, controlDirectory)
	if err != nil {
		return nil, err
	}
	m.useConnector(runtime)
	m.publishViewLocked()
	if err := waitForConnectorSocket(ctx, m.socketPath); err != nil {
		return nil, err
	}
	// The connector of this mode serves: the control directory a mode switch set aside can go.
	if m.plugin.cfg != nil && len(setAsideDirectories(m.plugin.cfg.StateDir, "secure-link-connector")) > 0 {
		go m.plugin.removeSetAsideConnectorDirectories(context.Background(), "secure-link-connector", image)
	}
	return nil, nil
}

// connectorRuntime is the connector container dials and syncs use.
type connectorRuntime struct {
	id, managementIP, socketPath string
	slot                         int
	attached                     map[string]struct{}
}

// connectorReplacement is a connector started next to the serving one. Until
// apply switches to it, dials keep using previous, whose links stay bound.
type connectorReplacement struct {
	previous         connectorRuntime
	previousBindings map[string]dockerSecureLinkBinding
	previousUnbound  map[string]struct{}
}

func (m *dockerSecureLinkManager) useConnector(runtime connectorRuntime) {
	m.connectorID = runtime.id
	m.managementIP = runtime.managementIP
	m.socketPath = runtime.socketPath
	m.slot = runtime.slot
	m.attached = runtime.attached
}

func connectorRuntimeOf(inspect container.InspectResponse, slot int, controlDirectory string) (connectorRuntime, error) {
	if inspect.NetworkSettings == nil {
		return connectorRuntime{}, errors.New("secure-link connector network settings are unavailable")
	}
	endpoint := inspect.NetworkSettings.Networks[secureLinkManagementNetwork]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return connectorRuntime{}, errors.New("secure-link connector management address is unavailable")
	}
	attached := map[string]struct{}{}
	for name := range inspect.NetworkSettings.Networks {
		if name != secureLinkManagementNetwork {
			attached[name] = struct{}{}
		}
	}
	return connectorRuntime{
		id: inspect.ID, managementIP: endpoint.IPAddress.String(), slot: slot, attached: attached,
		socketPath: filepath.Join(controlDirectory, secureLinkConnectorSlots[slot].socket),
	}, nil
}

// findConnector returns the connector to keep using and its slot (nil when
// there is none). The serving connector stays; after a daemon start, the one
// already running the image wins and any other is left from an interrupted
// replacement or retirement and is removed.
func (m *dockerSecureLinkManager) findConnector(ctx context.Context, image string) (int, *container.InspectResponse, error) {
	found := [len(secureLinkConnectorSlots)]*container.InspectResponse{}
	for slot, candidate := range secureLinkConnectorSlots {
		if m.connectorID != "" && slot != m.slot {
			// Serving: the other slot holds at most a connector being retired.
			continue
		}
		inspect, err := m.plugin.client.cli.ContainerInspect(ctx, candidate.name, mobyclient.ContainerInspectOptions{})
		if err != nil {
			if isNotFoundErr(err) {
				continue
			}
			return 0, nil, fmt.Errorf("inspect secure-link connector: %w", err)
		}
		found[slot] = &inspect.Container
	}
	if m.connectorID != "" {
		return m.slot, found[m.slot], nil
	}
	controlDirectory := filepath.Dir(m.socketPath)
	chosen := -1
	for _, preferred := range []func(*container.InspectResponse) bool{
		func(inspect *container.InspectResponse) bool {
			return validSecureLinkConnector(*inspect, image, controlDirectory)
		},
		func(inspect *container.InspectResponse) bool {
			return managedSecureLinkConnector(*inspect, controlDirectory)
		},
		func(*container.InspectResponse) bool { return true },
	} {
		for slot, inspect := range found {
			if chosen < 0 && inspect != nil && preferred(inspect) {
				chosen = slot
			}
		}
	}
	if chosen < 0 {
		return 0, nil, nil
	}
	for slot, inspect := range found {
		if slot == chosen || inspect == nil || !ownedSecureLinkConnector(*inspect) {
			continue
		}
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspect.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return 0, nil, fmt.Errorf("remove leftover secure-link connector: %w", err)
		}
	}
	return chosen, found[chosen], nil
}

// startReplacement starts the connector for the image in the other slot. Any
// failure leaves the serving connector and its links as they were.
func (m *dockerSecureLinkManager) startReplacement(ctx context.Context, image string, slot int) (*connectorReplacement, error) {
	unchanged := func(err error) (*connectorReplacement, error) {
		return nil, secureLinkConnectorUnchangedError{err}
	}
	if image != developmentSecureLinkImage {
		// Pulled while the serving connector still forwards every link.
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return unchanged(fmt.Errorf("ensure secure-link connector image: %w", err))
		}
	}
	next := 1 - slot
	if err := m.removeConnectorSlot(ctx, next); err != nil {
		return unchanged(err)
	}
	inspect, err := m.createConnector(ctx, image, next)
	if err == nil {
		var runtime connectorRuntime
		runtime, err = connectorRuntimeOf(*inspect, next, filepath.Dir(m.socketPath))
		if err == nil {
			err = waitForConnectorSocket(ctx, runtime.socketPath)
		}
		if err == nil {
			replacement := &connectorReplacement{
				previous: connectorRuntime{
					id: m.connectorID, managementIP: m.managementIP, socketPath: m.socketPath, slot: m.slot, attached: m.attached,
				},
				previousBindings: m.bindings, previousUnbound: m.unbound,
			}
			// Not published: dials go on to the previous connector until apply bound the links here.
			m.useConnector(runtime)
			return replacement, nil
		}
	}
	if removeErr := m.removeConnectorSlot(context.Background(), next); removeErr != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not remove the secure-link connector that failed to start", "error", removeErr)
	}
	return unchanged(fmt.Errorf("start replacement secure-link connector: %w", err))
}

// abortReplacement goes back to the connector that served before: its links
// are bound as they were, and the new connector is removed.
func (m *dockerSecureLinkManager) abortReplacement(replacement *connectorReplacement) {
	failed := m.slot
	m.useConnector(replacement.previous)
	m.bindings = replacement.previousBindings
	m.unbound = replacement.previousUnbound
	m.publishViewLocked()
	if err := m.removeConnectorSlot(context.Background(), failed); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not remove the secure-link connector whose links failed to bind", "error", err)
	}
}

// retireConnector removes a replaced connector once the tunnels through it
// are done: each one closes as soon as it is idle between requests (nginx
// then reconnects through the new connector), and the ones still busy after
// the limit are cut with the container.
func (m *dockerSecureLinkManager) retireConnector(previous connectorRuntime) {
	limit := secureLinkConnectorRetireLimit
	go func() {
		busy := m.plugin.proxyTunnels.drainWhere(func(connection *drainConn) bool {
			return connectionConnector(connection) == previous.id
		}, limit, secureLinkConnectorRetireTick)
		if busy > 0 && m.plugin.logger != nil {
			m.plugin.logger.Info("tunnels still busy on the replaced secure-link connector are cut", "tunnels", busy)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, previous.id, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) && m.plugin.logger != nil {
			// The next daemon start removes it.
			m.plugin.logger.Warn("could not remove the replaced secure-link connector", "error", err)
		}
	}()
}

func (m *dockerSecureLinkManager) createConnector(ctx context.Context, image string, slot int) (*container.InspectResponse, error) {
	if image != developmentSecureLinkImage {
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return nil, fmt.Errorf("ensure secure-link connector image: %w", err)
		}
	}
	controlDirectory := filepath.Dir(m.socketPath)
	_ = os.Remove(filepath.Join(controlDirectory, secureLinkConnectorSlots[slot].socket))
	pids := secureLinkConnectorPidsLimit
	created, createErr := m.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: "65532:65532",
			Env:    []string{secureLinkConnectorSocketEnv(slot)},
			Labels: map[string]string{"wiolett.gateway.managed": "secure-link-connector"},
		},
		HostConfig: &container.HostConfig{
			Binds:          []string{controlDirectory + ":/run/gateway"},
			GroupAdd:       connectorGroupAdd(),
			ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			Resources:     container.Resources{Memory: secureLinkConnectorMemory, NanoCPUs: secureLinkConnectorNanoCPUs, PidsLimit: &pids},
		},
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{secureLinkManagementNetwork: {}}},
		Name:             secureLinkConnectorSlots[slot].name,
	})
	if createErr != nil {
		return nil, fmt.Errorf("create secure-link connector: %w", createErr)
	}
	if _, startErr := m.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); startErr != nil {
		return nil, fmt.Errorf("start secure-link connector: %w", startErr)
	}
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect created secure-link connector: %w", err)
	}
	return &inspect.Container, nil
}

// removeConnectorSlot removes the managed connector in a slot, if any.
func (m *dockerSecureLinkManager) removeConnectorSlot(ctx context.Context, slot int) error {
	name := secureLinkConnectorSlots[slot].name
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect secure-link connector %s: %w", name, err)
	}
	if !managedSecureLinkConnector(inspect.Container, filepath.Dir(m.socketPath)) {
		return fmt.Errorf("refusing to remove non-managed container %s", name)
	}
	if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspect.Container.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("remove secure-link connector %s: %w", name, err)
	}
	return nil
}

func waitForConnectorSocket(ctx context.Context, socketPath string) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(socketPath); err == nil {
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
	return inspect.Config != nil && inspect.Config.Image == image && managedSecureLinkConnector(inspect, controlDirectory) &&
		inspect.HostConfig != nil && sameConnectorGroups(inspect.HostConfig.GroupAdd)
}

func ownedSecureLinkConnector(inspect container.InspectResponse) bool {
	return inspect.Config != nil && inspect.Config.Labels["wiolett.gateway.managed"] == "secure-link-connector"
}

// connectorSlot reports the slot of a container named like a connector.
func connectorSlot(inspect container.InspectResponse) (int, bool) {
	name := strings.TrimPrefix(inspect.Name, "/")
	for slot, candidate := range secureLinkConnectorSlots {
		if candidate.name == name {
			return slot, true
		}
	}
	return 0, false
}

func managedSecureLinkConnector(inspect container.InspectResponse, controlDirectory string) bool {
	config := inspect.Config
	host := inspect.HostConfig
	slot, named := connectorSlot(inspect)
	if !named || config == nil || host == nil ||
		(config.Image != developmentSecureLinkImage &&
			!immutableConnectorImagePattern.MatchString(config.Image) &&
			!officialConnectorReleaseTagPattern.MatchString(config.Image)) ||
		config.User != "65532:65532" ||
		config.Labels["wiolett.gateway.managed"] != "secure-link-connector" ||
		!validSecureLinkConnectorEnv(config.Env, secureLinkConnectorSocketEnv(slot)) ||
		len(config.ExposedPorts) != 0 || host.Privileged || host.PublishAllPorts || !host.ReadonlyRootfs ||
		len(host.CapAdd) != 0 || !containsFold(host.CapDrop, "ALL") || !allowedConnectorGroups(host.GroupAdd) ||
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

func secureLinkConnectorSocketEnv(slot int) string {
	return "GATEWAY_SECURE_LINK_SOCKET=/run/gateway/" + secureLinkConnectorSlots[slot].socket
}

func validSecureLinkConnectorEnv(values []string, socket string) bool {
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
	if err != nil && !isNotFoundErr(err) {
		return "", "", secureLinkTargetUnknownError{cause: err}
	}
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
	if _, err := m.restore(restored); err != nil {
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
	view := m.currentView()
	binding, ok := view.bindings[linkID]
	_, unbound := view.unbound[linkID]
	host := view.managementIP
	if !ok && unbound && host != "" {
		// Its target was unavailable at the last restore: a new restore
		// right away would find the same, so the dial shares a recent one.
		return nil, fmt.Errorf("proxy secure-link %s: %w", linkID, errSecureLinkTargetUnavailable)
	}
	if !ok || host == "" || binding.port == 0 {
		return nil, errors.New("proxy secure-link binding is unavailable")
	}
	if err := m.validateDialTarget(ctx, linkID, binding, time.Now()); err != nil {
		return nil, fmt.Errorf("validate proxy secure-link target: %w", err)
	}
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprintf("%d", binding.port)))
	if err != nil {
		return nil, err
	}
	return &connectorConn{Conn: connection, connectorID: view.connectorID}, nil
}

// connectorConn is a connection through one connector container: the tunnels
// of a replaced connector are drained before it is removed.
type connectorConn struct {
	net.Conn
	connectorID string
}

// CloseWrite passes a half-close on to the workload.
func (c *connectorConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

func connectionConnector(connection net.Conn) string {
	for {
		switch current := connection.(type) {
		case *connectorConn:
			return current.connectorID
		case *drainConn:
			connection = current.Conn
		default:
			return ""
		}
	}
}

// validateDialTarget checks through dockerd that the link's target still is
// the container and address the connector forwards to. A hung dockerd must
// not hang traffic to running workloads (B-8, D5): the check waits at most
// secureLinkValidateWait, and when dockerd does not answer, the connector
// keeps forwarding to the target it was bound to. That binding was validated
// while dockerd answered, and only dockerd can hand its address to another
// container. Dials skip the check for secureLinkDockerQuiet after such a
// timeout, so a frozen dockerd costs one wait per period, not one per tunnel.
//
// A target validated less than secureLinkValidateTTL ago for the same binding
// is not checked again, and concurrent dials of one link share one check: a
// relayed connection costs no dockerd call of its own (B-22).
func (m *dockerSecureLinkManager) validateDialTarget(ctx context.Context, linkID string, binding dockerSecureLinkBinding, now time.Time) error {
	m.validationMu.Lock()
	if last, ok := m.validated[linkID]; ok && last.binding == binding && now.Sub(last.at) < secureLinkValidateTTL {
		m.validationMu.Unlock()
		return nil
	}
	if running := m.validating[linkID]; running != nil && running.binding == binding {
		m.validationMu.Unlock()
		select {
		case <-running.done:
			return running.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	call := &dialValidation{binding: binding, at: now, done: make(chan struct{})}
	if m.validating == nil {
		m.validating = map[string]*dialValidation{}
	}
	m.validating[linkID] = call
	m.validationMu.Unlock()
	call.err = m.validateDialTargetNow(ctx, linkID, binding, now)
	m.validationMu.Lock()
	if m.validating[linkID] == call {
		delete(m.validating, linkID)
	}
	if m.validated == nil {
		m.validated = map[string]dialValidation{}
	}
	if call.err == nil {
		m.validated[linkID] = dialValidation{binding: binding, at: now}
	} else {
		delete(m.validated, linkID)
	}
	m.validationMu.Unlock()
	close(call.done)
	return call.err
}

func (m *dockerSecureLinkManager) validateDialTargetNow(ctx context.Context, linkID string, binding dockerSecureLinkBinding, now time.Time) error {
	m.dockerQuietMu.Lock()
	quiet := now.Before(m.dockerQuietUntil)
	m.dockerQuietMu.Unlock()
	if quiet {
		return nil
	}
	validateCtx, cancel := context.WithTimeout(ctx, secureLinkValidateWait)
	defer cancel()
	resolve := m.resolveTargetForDial
	if resolve == nil {
		resolve = m.resolveTarget
	}
	actualHost, actualNetwork, err := resolve(validateCtx, binding.targetContainer, binding.targetNetwork, binding.targetHost, false)
	// No answer in time, or no answer at all (dockerd restarting, a transport
	// error): no evidence the target changed.
	var unanswered secureLinkTargetUnknownError
	if err != nil && ctx.Err() == nil && (errors.Is(validateCtx.Err(), context.DeadlineExceeded) || errors.As(err, &unanswered)) {
		m.dockerQuietMu.Lock()
		first := m.dockerQuietUntil.IsZero()
		m.dockerQuietUntil = now.Add(secureLinkDockerQuiet)
		m.dockerQuietMu.Unlock()
		if first {
			m.plugin.logger.Warn("dockerd did not answer a secure-link target check; links keep their validated targets until it answers",
				"link_id", linkID, "wait", secureLinkValidateWait.String())
		}
		return nil
	}
	m.dockerQuietMu.Lock()
	recovered := !m.dockerQuietUntil.IsZero()
	m.dockerQuietUntil = time.Time{}
	m.dockerQuietMu.Unlock()
	if recovered {
		m.plugin.logger.Info("dockerd answers secure-link target checks again")
	}
	if err != nil || actualHost != binding.targetHost || actualNetwork != binding.targetNetwork {
		if err == nil {
			err = errors.New("target identity changed")
		}
		return err
	}
	return nil
}

func (m *dockerSecureLinkManager) removeConnector(ctx context.Context) error {
	if m.connectorID != "" {
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, m.connectorID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove secure-link connector: %w", err)
		}
	}
	// Both slots: a replaced connector may still be retiring.
	for slot := range secureLinkConnectorSlots {
		if err := m.removeConnectorSlot(ctx, slot); err != nil {
			return err
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
	for _, slot := range secureLinkConnectorSlots {
		_ = os.Remove(filepath.Join(filepath.Dir(m.socketPath), slot.socket))
	}
	m.connectorID = ""
	m.managementIP = ""
	m.slot = 0
	m.socketPath = filepath.Join(filepath.Dir(m.socketPath), secureLinkConnectorSlots[0].socket)
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
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
	// New or changed availability members: probe their readiness now (D6).
	p.memberReadiness.signal()
	if p.lease != nil {
		// Lease-gated links may have appeared or changed policy.
		p.reconcileRelayRegistrations()
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
		if network, ok := networks[binding.LinkId]; ok {
			binding.TargetNetwork = network
		}
		binding.TargetHost = ""
	}
	return normalized
}

// normalizeTargetBindings persists a restore. A link the restore left
// unbound keeps its committed network: a deployment router link must not
// lose its managed network because the router was down at that moment.
func normalizeTargetBindings(command *pb.SyncProxySecureLinksCommand, statuses []dockerSecureLinkStatus) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	networks := make(map[string]string, len(statuses))
	for _, status := range statuses {
		networks[status.LinkID] = status.TargetNetwork
	}
	for _, binding := range normalized.Bindings {
		if network, bound := networks[binding.LinkId]; bound {
			binding.TargetNetwork = network
		}
		binding.TargetHost = ""
	}
	return normalized
}
