package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

func secureLinkConnectorInspect(id, image, controlDirectory string) container.InspectResponse {
	pids := secureLinkConnectorPidsLimit
	return container.InspectResponse{
		ID: id,
		Config: &container.Config{
			Image: image,
			User:  "65532:65532",
			Env:   []string{"GATEWAY_SECURE_LINK_SOCKET=" + secureLinkControlSocket},
			Labels: map[string]string{
				"wiolett.gateway.managed": "secure-link-connector",
			},
		},
		HostConfig: &container.HostConfig{
			Binds:          []string{controlDirectory + ":/run/gateway"},
			ReadonlyRootfs: true,
			CapDrop:        []string{"ALL"},
			SecurityOpt:    []string{"no-new-privileges"},
			RestartPolicy:  container.RestartPolicy{Name: "unless-stopped"},
			Resources: container.Resources{
				Memory: secureLinkConnectorMemory, NanoCPUs: secureLinkConnectorNanoCPUs, PidsLimit: &pids,
			},
		},
		NetworkSettings: &container.NetworkSettings{Ports: network.PortMap{}},
	}
}

func TestValidSecureLinkConnectorRejectsPrivilegeAndMountDrift(t *testing.T) {
	image := "registry.example/gateway/secure-link-connector@sha256:" + strings.Repeat("a", 64)
	inspect := secureLinkConnectorInspect("connector-id", image, "/state/secure-link-connector")
	if !validSecureLinkConnector(inspect, image, "/state/secure-link-connector") {
		t.Fatal("expected exact managed connector configuration to be accepted")
	}
	officialImage := "ghcr.io/the-square-labs/gateway/secure-link-connector:v99.0.0-relay"
	officialInspect := secureLinkConnectorInspect("official-connector-id", officialImage, "/state/secure-link-connector")
	if !validSecureLinkConnector(officialInspect, officialImage, "/state/secure-link-connector") {
		t.Fatal("expected an official release-tag connector to survive daemon restart validation")
	}
	if !ownedSecureLinkConnector(inspect) {
		t.Fatal("expected managed label to establish connector ownership")
	}
	unowned := inspect
	unowned.Config = &container.Config{Image: image}
	if ownedSecureLinkConnector(unowned) {
		t.Fatal("unmanaged container was treated as replaceable")
	}

	inspect.HostConfig.Privileged = true
	if validSecureLinkConnector(inspect, image, "/state/secure-link-connector") {
		t.Fatal("expected privileged connector to be replaced")
	}
	inspect.HostConfig.Privileged = false
	inspect.HostConfig.Binds = append(inspect.HostConfig.Binds, "/var/run/docker.sock:/var/run/docker.sock")
	if validSecureLinkConnector(inspect, image, "/state/secure-link-connector") {
		t.Fatal("expected connector with Docker socket mount to be replaced")
	}
}

func TestValidSecureLinkConnectorEnvAllowsOnlySocketAndCanonicalPath(t *testing.T) {
	socket := "GATEWAY_SECURE_LINK_SOCKET=" + secureLinkControlSocket
	for _, values := range [][]string{{socket}, {socket, secureLinkConnectorPathEnv}, {secureLinkConnectorPathEnv, socket}} {
		if !validSecureLinkConnectorEnv(values) {
			t.Fatalf("expected connector env to be accepted: %#v", values)
		}
	}
	for _, values := range [][]string{{}, {secureLinkConnectorPathEnv}, {socket, socket}, {socket, "SECRET=value"}, {socket, "PATH=/tmp"}} {
		if validSecureLinkConnectorEnv(values) {
			t.Fatalf("unexpected connector env was accepted: %#v", values)
		}
	}
}

func TestRemoveConnectorDiscoversManagedContainerAfterRestart(t *testing.T) {
	directory := t.TempDir()
	image := "registry.example/gateway/secure-link-connector@sha256:" + strings.Repeat("b", 64)
	inspect := secureLinkConnectorInspect("connector-id", image, directory)
	var removedContainer, removedNetwork bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/"+secureLinkConnectorName+"/json"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(inspect)
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/containers/connector-id"):
			removedContainer = true
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks/"+secureLinkManagementNetwork):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(network.Inspect{Network: network.Network{
				ID: "management-network-id", Driver: "bridge", Internal: true,
				Labels: map[string]string{"wiolett.gateway.managed": "secure-link"},
			}})
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/networks/management-network-id"):
			removedNetwork = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost(server.URL), mobyclient.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: &Client{cli: cli}}, socketPath: filepath.Join(directory, "secure-link.sock"),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	if err := manager.removeConnector(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !removedContainer || !removedNetwork {
		t.Fatalf("cleanup container=%v network=%v", removedContainer, removedNetwork)
	}
}

func TestSecureLinkManagementNetworkMustBeInternalAndManaged(t *testing.T) {
	valid := network.Inspect{Network: network.Network{
		Driver: "bridge", Internal: true,
		Labels: map[string]string{"wiolett.gateway.managed": "secure-link"},
	}}
	if !validSecureLinkManagementNetwork(valid) {
		t.Fatal("expected exact managed internal network to be accepted")
	}
	valid.Internal = false
	if validSecureLinkManagementNetwork(valid) {
		t.Fatal("externally reachable management network was accepted")
	}
}

func TestDialCurrentRejectsAReassignedTargetAddress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/containers/app/json") {
			http.NotFound(w, r)
			return
		}
		inspect := container.InspectResponse{
			State:      &container.State{Running: true},
			HostConfig: &container.HostConfig{NetworkMode: "app-net"},
			NetworkSettings: &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
				"app-net": {IPAddress: netip.MustParseAddr("10.0.0.9")},
			}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(inspect)
	}))
	defer server.Close()
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost(server.URL), mobyclient.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: &Client{cli: cli}}, managementIP: "127.0.0.1",
		bindings: map[string]dockerSecureLinkBinding{
			"11111111-1111-4111-8111-111111111111": {
				port: 12345, targetContainer: "app", targetNetwork: "app-net", targetHost: "10.0.0.8",
			},
		},
	}
	if _, err := manager.dialCurrent(context.Background(), "11111111-1111-4111-8111-111111111111"); err == nil || !strings.Contains(err.Error(), "target address changed") {
		t.Fatalf("expected stale target rejection, got %v", err)
	}
}

func TestSelectSecureLinkTargetNetworkReselectsOnlyForContainerLinks(t *testing.T) {
	networks := map[string]*network.EndpointSettings{
		"primary":  {IPAddress: netip.MustParseAddr("10.10.0.2")},
		"fallback": {IPAddress: netip.MustParseAddr("10.20.0.2")},
	}
	selected, err := selectSecureLinkTargetNetwork(networks, "primary", "removed-network", true)
	if err != nil || selected != "primary" {
		t.Fatalf("container reselection = %q, %v", selected, err)
	}
	if _, err := selectSecureLinkTargetNetwork(networks, "primary", "managed-deployment-network", false); err == nil {
		t.Fatal("deployment link unexpectedly reselected away from its managed network")
	}
	selected, err = selectSecureLinkTargetNetwork(networks, "missing-primary", "", true)
	if err != nil || selected != "fallback" {
		t.Fatalf("deterministic fallback = %q, %v", selected, err)
	}
}

func TestDialWithOneRestoreReplaysBindingsBeforeReturningFailure(t *testing.T) {
	attempts := 0
	restored := false
	local, peer := net.Pipe()
	t.Cleanup(func() {
		local.Close()
		peer.Close()
	})
	connection, err := dialWithOneRestore(
		context.Background(),
		"11111111-1111-4111-8111-111111111111",
		func(context.Context, string) (net.Conn, error) {
			attempts++
			if !restored {
				return nil, errors.New("stale connector binding port")
			}
			return local, nil
		},
		func(error) error {
			restored = true
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if connection != local || attempts != 2 || !restored {
		t.Fatalf("connection=%v attempts=%d restored=%v", connection, attempts, restored)
	}
}

func TestSecureLinkRecoveryCoalescesConcurrentBindingReplays(t *testing.T) {
	manager := &dockerSecureLinkManager{}
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32

	restore := func() error {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return nil
	}

	const parallel = 16
	var ready sync.WaitGroup
	var completed sync.WaitGroup
	ready.Add(parallel)
	completed.Add(parallel)
	begin := make(chan struct{})
	for range parallel {
		go func() {
			defer completed.Done()
			ready.Done()
			<-begin
			_ = manager.restoreCoalesced(restore, false)
		}()
	}
	ready.Wait()
	close(begin)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("recovery did not start")
	}
	time.Sleep(25 * time.Millisecond)
	close(release)
	completed.Wait()
	if got := calls.Load(); got != 1 {
		t.Fatalf("concurrent recovery replayed bindings %d times", got)
	}
	if err := manager.restoreCoalesced(restore, false); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("recovery burst replayed bindings %d times", got)
	}
	if err := manager.restoreCoalesced(restore, true); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("changed target did not bypass cached recovery: %d replays", got)
	}
}

func TestNormalizeResolvedTargetBindingsPersistsTheValidatedDestination(t *testing.T) {
	command := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: "11111111-1111-4111-8111-111111111111", TargetContainer: "replacement", TargetHost: "untrusted-input",
	}}}
	normalized := normalizeResolvedTargetBindings(command, []resolvedSecureLinkTarget{{
		binding: command.Bindings[0], host: "10.0.0.8", network: "validated-net",
	}})
	if normalized.Bindings[0].TargetNetwork != "validated-net" || normalized.Bindings[0].TargetHost != "" {
		t.Fatalf("normalized binding = %+v", normalized.Bindings[0])
	}
	if command.Bindings[0].TargetNetwork != "" || command.Bindings[0].TargetHost != "untrusted-input" {
		t.Fatal("normalization mutated the incoming command")
	}
}

func TestDormantMemberWithStoppedStandbyDoesNotFailTheSync(t *testing.T) {
	bindings := []*pb.ProxySecureLinkBinding{
		{LinkId: "11111111-1111-4111-8111-111111111111", TargetContainer: "serving", TargetNetwork: "net-a"},
		{LinkId: "22222222-2222-4222-8222-222222222222", TargetContainer: "standby", TargetNetwork: "net-b", Dormant: true, AvailabilityPolicyId: "policy-1"},
	}
	resolve := func(binding *pb.ProxySecureLinkBinding) (string, string, error) {
		if binding.TargetContainer == "standby" {
			return "", "", errSecureLinkTargetUnavailable
		}
		return "10.0.0.2", binding.TargetNetwork, nil
	}
	resolved, networks, skipped, err := resolveSecureLinkTargets(bindings, resolve, false)
	if err != nil || len(resolved) != 1 || len(networks) != 1 || len(skipped) != 1 {
		t.Fatalf("dormant standby must be skipped, resolved=%d networks=%v err=%v", len(resolved), networks, err)
	}
	normalized := normalizeResolvedTargetBindings(&pb.SyncProxySecureLinksCommand{Bindings: bindings}, resolved)
	if len(normalized.Bindings) != 2 || normalized.Bindings[1].TargetNetwork != "net-b" {
		t.Fatalf("the dormant member must stay in the committed state with its network: %+v", normalized.Bindings)
	}
	bindings[1].Dormant = false
	if _, _, _, err := resolveSecureLinkTargets(bindings, resolve, false); err == nil {
		t.Fatal("a serving member with a stopped target must still fail the sync")
	}
}

// TestSecureLinkRestoreBindsTheOtherLinksWhenOneTargetIsDown reproduces a node
// reboot where one link's target (a deployment router) did not come back: the
// restore binds every other link of the node instead of none.
func TestSecureLinkRestoreBindsTheOtherLinksWhenOneTargetIsDown(t *testing.T) {
	directory, err := os.MkdirTemp("", "sl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "secure-link.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	var syncMu sync.Mutex
	var synced [][]securelink.BindingConfig
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			var request securelink.SyncRequest
			if securelink.ReadJSON(connection, &request) == nil {
				syncMu.Lock()
				synced = append(synced, request.Bindings)
				syncMu.Unlock()
				response := securelink.SyncResponse{Version: securelink.ProtocolVersion}
				for i, binding := range request.Bindings {
					response.Bindings = append(response.Bindings, securelink.BindingStatus{ID: binding.ID, Generation: binding.Generation, Port: uint16(20000 + i)})
				}
				_ = securelink.WriteJSON(connection, response)
			}
			_ = connection.Close()
		}
	}()

	connector := secureLinkConnectorInspect("connector-id", developmentSecureLinkImage, directory)
	connector.State = &container.State{Running: true}
	connector.NetworkSettings = &container.NetworkSettings{Ports: network.PortMap{}, Networks: map[string]*network.EndpointSettings{
		secureLinkManagementNetwork: {IPAddress: netip.MustParseAddr("172.31.0.2")},
	}}
	targets := map[string]container.InspectResponse{
		"router-a": {
			ID: "router-a-id", State: &container.State{Running: true}, HostConfig: &container.HostConfig{NetworkMode: "net-a"},
			NetworkSettings: &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{"net-a": {IPAddress: netip.MustParseAddr("10.0.1.2")}}},
		},
		// Exited (255) after the reboot: restart policy "no".
		"router-b": {
			ID: "router-b-id", State: &container.State{Running: false, ExitCode: 255}, HostConfig: &container.HostConfig{NetworkMode: "net-b"},
			NetworkSettings: &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{}},
		},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks/"+secureLinkManagementNetwork):
			_ = json.NewEncoder(w).Encode(network.Inspect{Network: network.Network{
				ID: "management-network-id", Driver: "bridge", Internal: true,
				Labels: map[string]string{"wiolett.gateway.managed": "secure-link"},
			}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/"+secureLinkConnectorName+"/json"):
			_ = json.NewEncoder(w).Encode(connector)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/networks/net-a/connect"):
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/"):
			name := strings.TrimSuffix(r.URL.Path[strings.LastIndex(r.URL.Path, "/containers/")+len("/containers/"):], "/json")
			if target, ok := targets[name]; ok {
				_ = json.NewEncoder(w).Encode(target)
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "No such container: " + name})
		default:
			t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotImplemented)
		}
	}))
	defer server.Close()
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost(server.URL), mobyclient.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()

	serving := "11111111-1111-4111-8111-111111111111"
	down := "22222222-2222-4222-8222-222222222222"
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(&pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: serving, Role: "target", Generation: 1, TargetContainer: "router-a", TargetNetwork: "net-a", TargetPort: 8080, ConnectorImage: developmentSecureLinkImage},
		{LinkId: down, Role: "target", Generation: 1, TargetContainer: "router-b", TargetNetwork: "net-b", TargetPort: 8080, ConnectorImage: developmentSecureLinkImage},
	}}); err != nil {
		t.Fatal(err)
	}
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{
			client: &Client{cli: cli}, secureLinkState: store,
			logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		socketPath: socketPath, bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}

	if err := manager.restoreBindings(); err != nil {
		t.Fatalf("one stopped target must not fail the restore of the others: %v", err)
	}
	if binding, ok := manager.bindings[serving]; !ok || binding.port != 20000 || binding.targetHost != "10.0.1.2" {
		t.Fatalf("the running target's link must be bound, bindings = %+v", manager.bindings)
	}
	if _, ok := manager.bindings[down]; ok {
		t.Fatal("the stopped target's link must stay unbound")
	}
	syncMu.Lock()
	if len(synced) != 1 || len(synced[0]) != 1 || synced[0][0].ID != serving {
		t.Fatalf("connector syncs = %+v, want the running target's link only", synced)
	}
	syncMu.Unlock()
	if _, err := manager.dialCurrent(context.Background(), down); !errors.Is(err, errSecureLinkTargetUnavailable) {
		t.Fatalf("dial of the unbound link = %v, want target unavailable so recoveries coalesce", err)
	}
}

func TestSecureLinkRestoreResolvesPerBinding(t *testing.T) {
	bindings := []*pb.ProxySecureLinkBinding{
		{LinkId: "11111111-1111-4111-8111-111111111111", TargetContainer: "serving", TargetNetwork: "net-a"},
		{LinkId: "22222222-2222-4222-8222-222222222222", TargetContainer: "stopped-router", TargetNetwork: "net-b"},
		{LinkId: "33333333-3333-4333-8333-333333333333", TargetContainer: "detached", TargetNetwork: "net-c"},
	}
	resolve := func(binding *pb.ProxySecureLinkBinding) (string, string, error) {
		switch binding.TargetContainer {
		case "stopped-router":
			return "", "", errSecureLinkTargetUnavailable
		case "detached":
			return "", "", errors.New("target container is not attached to the selected network")
		}
		return "10.0.0.2", binding.TargetNetwork, nil
	}
	resolved, networks, skipped, err := resolveSecureLinkTargets(bindings, resolve, true)
	if err != nil || len(resolved) != 1 || len(skipped) != 2 || len(networks) != 1 {
		t.Fatalf("restore must bind the resolvable link and skip the others: resolved=%d skipped=%d networks=%v err=%v", len(resolved), len(skipped), networks, err)
	}
	if _, _, _, err := resolveSecureLinkTargets(bindings, resolve, false); err == nil {
		t.Fatal("a Gateway sync keeps refusing an incomplete target set")
	}
}

func TestNormalizeTargetBindingsKeepsTheNetworkOfAnUnboundLink(t *testing.T) {
	restored := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: "11111111-1111-4111-8111-111111111111", TargetContainer: "app", TargetNetwork: "old-net", TargetHost: "10.0.0.2"},
		{LinkId: "22222222-2222-4222-8222-222222222222", TargetContainer: "router", TargetNetwork: "gwdep-dep-1", TargetHost: "10.0.0.3"},
	}}
	normalized := normalizeTargetBindings(restored, []dockerSecureLinkStatus{{LinkID: "11111111-1111-4111-8111-111111111111", TargetNetwork: "new-net"}})
	if got := normalized.Bindings[0]; got.TargetNetwork != "new-net" || got.TargetHost != "" {
		t.Fatalf("bound link = %+v", got)
	}
	if got := normalized.Bindings[1]; got.TargetNetwork != "gwdep-dep-1" || got.TargetHost != "" {
		t.Fatalf("an unbound router link must keep its managed network, got %+v", got)
	}
}
