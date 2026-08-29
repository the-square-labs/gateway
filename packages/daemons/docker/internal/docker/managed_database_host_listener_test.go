package docker

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestManagedDatabaseHostListenerConfigRequiresFencedBindingGrant(t *testing.T) {
	assignment := managedDatabaseHostListenerAssignment("binding-1", "gateway-db-binding-1", "172.28.0.1", 5432, 7, []string{"container:api-blue", "container:api-green"})
	config, err := managedDatabaseHostListenerConfigFromAssignment(assignment)
	if err != nil {
		t.Fatalf("listener config: %v", err)
	}
	if config.bindingID != "binding-1" || config.networkName != "gateway-db-binding-1" || config.listenAddress.String() != "172.28.0.1" || config.listenPort != 5432 || config.routeGeneration != 7 {
		t.Fatalf("unexpected listener config: %#v", config)
	}
	if len(config.allowedSources) != 2 || config.allowedSources[0] != "container:api-blue" || config.allowedSources[1] != "container:api-green" {
		t.Fatalf("unexpected allowed sources: %#v", config.allowedSources)
	}

	assignment.ManagedDatabaseListener.RouteGeneration = 0
	if _, err := managedDatabaseHostListenerConfigFromAssignment(assignment); err == nil {
		t.Fatal("expected route generation to be required")
	}
}

func TestManagedDatabaseNetworkGatewayAddressUsesIPv4Gateway(t *testing.T) {
	address, err := managedDatabaseNetworkGatewayAddress(managedDatabaseHostListenerNetwork("gateway-db-binding-1", "network-1", "172.28.0.1", nil))
	if err != nil {
		t.Fatalf("network gateway: %v", err)
	}
	if address.String() != "172.28.0.1" {
		t.Fatalf("gateway = %s, want 172.28.0.1", address)
	}
}

func TestManagedDatabaseHostListenerRoutesAllowedPeerWithoutHandshake(t *testing.T) {
	port := availableTCPPort(t)
	listenerNetwork := managedDatabaseHostListenerNetwork("gateway-db-binding-1", "network-1", "127.0.0.1", map[string]string{"api-blue": "127.0.0.1/8"})
	routed := make(chan struct {
		bindingID       string
		routeGeneration uint64
	}, 1)
	manager := &managedDatabaseHostListenerManager{
		listeners: map[string]*managedDatabaseHostListener{},
		global:    make(chan struct{}, managedDatabaseHostListenerGlobalConnections),
		inspectNetwork: func(context.Context, string) (network.Inspect, error) {
			return listenerNetwork, nil
		},
		inspectContainer: func(context.Context, string) (mobyclient.ContainerInspectResult, error) {
			return mobyclient.ContainerInspectResult{Container: container.InspectResponse{
				Name:   "/api-blue",
				Config: &container.Config{Labels: map[string]string{}},
			}}, nil
		},
		openBinding: func(_ net.Conn, bindingID string, routeGeneration uint64) {
			routed <- struct {
				bindingID       string
				routeGeneration uint64
			}{bindingID: bindingID, routeGeneration: routeGeneration}
		},
	}
	bundle := &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{
		managedDatabaseHostListenerAssignment("binding-1", "gateway-db-binding-1", "127.0.0.1", uint32(port), 9, []string{"container:api-blue"}),
	}}
	statuses := manager.reconcile(context.Background(), bundle)
	if status := statuses["binding-1"]; status.State != "ready" || status.Address != "127.0.0.1" || status.Port != uint16(port) {
		t.Fatalf("listener status = %#v", status)
	}
	t.Cleanup(func() { manager.reconcile(context.Background(), &pb.SyncRelayGrantsCommand{}) })

	connection, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port)), time.Second)
	if err != nil {
		t.Fatalf("dial listener: %v", err)
	}
	defer connection.Close()

	select {
	case received := <-routed:
		if received.bindingID != "binding-1" || received.routeGeneration != 9 {
			t.Fatalf("unexpected relay route: %#v", received)
		}
	case <-time.After(time.Second):
		t.Fatal("listener did not route allowed peer without a client handshake")
	}
}

func TestManagedDatabaseHostListenerRemovalClosesActiveConnections(t *testing.T) {
	tcpListener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	manager := &managedDatabaseHostListenerManager{
		listeners: map[string]*managedDatabaseHostListener{
			"binding-1": {
				listener:    tcpListener,
				connections: map[net.Conn]struct{}{server: {}},
			},
		},
		global: make(chan struct{}, managedDatabaseHostListenerGlobalConnections),
	}
	defer client.Close()

	manager.reconcile(context.Background(), &pb.SyncRelayGrantsCommand{})
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected active listener connection to close after grant removal")
	}
}

func TestManagedDatabaseListenerPeerRequiresAllowedNetworkEndpoint(t *testing.T) {
	inspected := managedDatabaseHostListenerNetwork("gateway-db-binding-1", "network-1", "172.28.0.1", map[string]string{
		"api-blue": "172.28.0.2/24",
		"other":    "172.28.0.3/24",
	})
	if id := managedDatabaseListenerPeerContainerID(inspected, netip.MustParseAddr("172.28.0.2")); id != "api-blue" {
		t.Fatalf("expected allowed container endpoint id, got %q", id)
	}
	if !managedDatabaseListenerSourceAllowed(
		mobyclient.ContainerInspectResult{Container: container.InspectResponse{Name: "/api-blue", Config: &container.Config{Labels: map[string]string{}}}},
		[]string{"container:api-blue"},
	) {
		t.Fatal("expected exact container source selector to pass")
	}
	if managedDatabaseListenerSourceAllowed(
		mobyclient.ContainerInspectResult{Container: container.InspectResponse{Config: &container.Config{Labels: map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "other"}}}},
		[]string{"deployment:11111111-1111-4111-8111-111111111111"},
	) {
		t.Fatal("unexpected authorization for disallowed deployment")
	}
}

func managedDatabaseHostListenerAssignment(bindingID, networkName, address string, port uint32, generation uint64, allowed []string) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: "managed_database_binding", OwnerId: bindingID,
		Grant: &pb.RelaySignedGrant{KeyId: "key", Payload: []byte("payload"), Signature: []byte("signature")},
		ManagedDatabaseListener: &pb.ManagedDatabaseListener{
			NetworkName: networkName, ListenAddress: address, ListenPort: port, RouteGeneration: generation, AllowedSources: allowed,
		},
	}
}

func managedDatabaseHostListenerNetwork(name, id, gateway string, endpoints map[string]string) network.Inspect {
	containers := make(map[string]network.EndpointResource, len(endpoints))
	for containerName, address := range endpoints {
		containers[containerName] = network.EndpointResource{Name: containerName, IPv4Address: netip.MustParsePrefix(address)}
	}
	return network.Inspect{
		Network: network.Network{
			Name: name, ID: id, Driver: "bridge",
			IPAM: network.IPAM{Config: []network.IPAMConfig{{Gateway: netip.MustParseAddr(gateway)}}},
		},
		Containers: containers,
	}
}

func availableTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
