package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
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
		func() error {
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
