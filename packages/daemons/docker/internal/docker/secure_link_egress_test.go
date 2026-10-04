package docker

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const (
	egressTestLinkID  = "6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
	egressTestNetwork = "gateway-link-6a1b2c3d4e5f4a6b"
	egressTestDBNet   = "gateway-db-0123456789abcdef"
)

// egressFakeEngine adds the link networks of create_link_network to the connector engine: network inspects, and
// connects that record the connector's address and aliases there.
type egressFakeEngine struct {
	*fakeConnectorEngine
	removedNetworks []string
	// gateways are database link networks created before (no reserved address), by name, with their gateway.
	gateways map[string]string
}

func (e *egressFakeEngine) serveNetwork(name, gateway string) {
	if e.gateways == nil {
		e.gateways = map[string]string{}
	}
	e.gateways[name] = gateway
}

func (e *egressFakeEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serveLinks)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *egressFakeEngine) serveLinks(request *http.Request) (*http.Response, error) {
	respond := func(code int, body any) (*http.Response, error) {
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(string(encoded))), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if parts[0] != "networks" || len(parts) < 2 {
		return e.serve(request)
	}
	name := parts[1]
	switch {
	case request.Method == http.MethodDelete && len(parts) == 2:
		e.mu.Lock()
		e.removedNetworks = append(e.removedNetworks, name)
		e.mu.Unlock()
		return respond(http.StatusNoContent, map[string]any{})
	case name == egressTestNetwork && request.Method == http.MethodGet:
		e.mu.Lock()
		defer e.mu.Unlock()
		containers := map[string]any{}
		for _, current := range e.containers {
			if endpoint := current.networks[egressTestNetwork]; endpoint != nil {
				containers[current.id] = map[string]any{"Name": current.name, "IPv4Address": endpoint["IPAddress"].(string) + "/28"}
			}
		}
		return respond(http.StatusOK, map[string]any{
			"Name": egressTestNetwork, "Id": "link-net-id", "Driver": "bridge", "Internal": true,
			"Labels":     map[string]string{"wiolett.gateway.managed": linkNetworkLabel},
			"IPAM":       map[string]any{"Config": []map[string]string{{"Subnet": "10.213.0.0/28", "Gateway": "10.213.0.1", "IPRange": "10.213.0.8/29"}}},
			"Containers": containers,
		})
	case e.gateways[name] != "" && request.Method == http.MethodGet:
		return respond(http.StatusOK, map[string]any{
			"Name": name, "Id": name + "-id", "Driver": "bridge",
			"IPAM": map[string]any{"Config": []map[string]string{{"Subnet": strings.TrimSuffix(e.gateways[name], ".1") + ".0/24", "Gateway": e.gateways[name]}}},
		})
	case len(parts) == 3 && parts[2] == "connect":
		var body struct {
			Container      string
			EndpointConfig struct {
				Aliases    []string
				IPAMConfig *struct{ IPv4Address string }
			}
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.mu.Lock()
		defer e.mu.Unlock()
		current := e.byIDOrName(body.Container)
		if current == nil {
			return respond(http.StatusNotFound, map[string]string{"message": "no such container"})
		}
		address := "10.213.0.9"
		if body.EndpointConfig.IPAMConfig != nil && body.EndpointConfig.IPAMConfig.IPv4Address != "" {
			address = body.EndpointConfig.IPAMConfig.IPv4Address
		}
		if current.networks == nil {
			current.networks = map[string]map[string]any{}
		}
		networkID := "link-net-id"
		if name != egressTestNetwork {
			networkID = name + "-id"
		}
		current.networks[name] = map[string]any{"IPAddress": address, "Aliases": body.EndpointConfig.Aliases, "NetworkID": networkID}
		return respond(http.StatusOK, map[string]any{})
	case len(parts) == 3 && parts[2] == "disconnect":
		var body struct{ Container string }
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.mu.Lock()
		defer e.mu.Unlock()
		if current := e.byIDOrName(body.Container); current != nil {
			delete(current.networks, name)
		}
		return respond(http.StatusOK, map[string]any{})
	}
	return e.serve(request)
}

func egressTestBundle(egress ...*pb.RelayGrantAssignment) *pb.SyncRelayGrantsCommand {
	return &pb.SyncRelayGrantsCommand{PolicyRevision: 1, Grants: egress}
}

func egressTestAssignment(id, networkName string) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: containerLinkOwnerKind, OwnerId: id, Grant: &pb.RelaySignedGrant{KeyId: "k"},
		SecureLinkEgress: &pb.SecureLinkEgress{NetworkName: networkName, Alias: "app", ListenPort: 8080, RouteGeneration: 3,
			ConnectorImage: replaceTestNewImage},
	}
}

func (e *egressFakeEngine) lastRequest(name string) securelink.SyncRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	current := e.containers[name]
	if current == nil || len(current.requests) == 0 {
		e.t.Fatalf("connector %s received no sync", name)
	}
	return current.requests[len(current.requests)-1]
}

// The connector's egress side: a node with only egress gets a connector with the egress image, joined to the link
// network at its reserved address with the link's alias. Ingress syncs keep the egress listeners, failClosed drops
// ingress only, the connector stays without ingress while egress remains, and goes with the last egress.
func TestEgressFollowsTheGrantBundle(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: engine.controlDir + "/" + secureLinkConnectorSlots[0].socket,
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	connector := secureLinkConnectorSlots[0].name

	invalidID := "7b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"
	statuses := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork),
		egressTestAssignment(invalidID, "user-network")))
	ready := statuses[egressTestLinkID]
	if ready.State != egressStateReady || ready.Address != "10.213.0.2" || ready.Port != 8080 || ready.RouteGeneration != 3 {
		t.Fatalf("egress status %+v", ready)
	}
	if statuses[invalidID].State != egressStateError {
		t.Fatalf("an egress on a user network was not refused: %+v", statuses[invalidID])
	}
	endpoint := engine.containers[connector].networks[egressTestNetwork]
	if endpoint["IPAddress"] != "10.213.0.2" || len(endpoint["Aliases"].([]string)) != 1 || endpoint["Aliases"].([]string)[0] != "app" {
		t.Fatalf("connector endpoint on the link network %+v", endpoint)
	}
	request := engine.lastRequest(connector)
	if len(request.Egress) != 1 || request.Egress[0].ListenHost != "10.213.0.2" || request.Egress[0].AllowedPrefix != "10.213.0.0/28" ||
		request.Egress[0].OwnerKind != containerLinkOwnerKind || request.Egress[0].ListenPort != 8080 {
		t.Fatalf("egress sent to the connector %+v", request.Egress)
	}
	if !manager.egress.listeningOn(egressTestNetwork) {
		t.Fatal("the link network is not reported as served by the connector")
	}

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("ingress apply: %v", err)
	}
	if request := engine.lastRequest(connector); len(request.Bindings) != 1 || len(request.Egress) != 1 {
		t.Fatalf("an ingress sync did not keep the egress listener: %+v", request)
	}
	manager.mu.Lock()
	manager.failClosed(t.Context())
	manager.mu.Unlock()
	if request := engine.lastRequest(connector); len(request.Bindings) != 0 || len(request.Egress) != 1 {
		t.Fatalf("failClosed did not keep the egress listener: %+v", request)
	}

	if _, err := manager.apply(&pb.SyncProxySecureLinksCommand{}, nil, nil, false); err != nil {
		t.Fatalf("apply without ingress: %v", err)
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("the connector serving egress was removed with its last ingress binding: %v", removed)
	}
	if request := engine.lastRequest(connector); len(request.Bindings) != 0 || len(request.Egress) != 1 {
		t.Fatalf("connector state without ingress %+v", request)
	}

	manager.syncEgress(egressTestBundle())
	if removed := engine.removedIDs(); len(removed) != 1 {
		t.Fatalf("the connector without links was not removed: %v", removed)
	}
	if manager.egress.listeningOn(egressTestNetwork) {
		t.Fatal("the link network is still reported as served")
	}
}

// A database consumer recreated while the connector serves its link gets no ExtraHosts entry for the link alias: it
// resolves the alias through Docker's DNS to the connector (C6). Other database links keep the host listener entry.
func TestDatabaseExtraHostsLeaveOutLinksServedByTheConnector(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	cli := engine.client()
	served := map[string]bool{egressTestDBNet: true}
	cli.egressListening = func(name string) bool { return served[name] }
	other := "gateway-db-fedcba9876543210"
	engine.serveNetwork(other, "172.30.5.1")

	entries, err := cli.managedDatabaseHostEntries(t.Context(), []string{egressTestDBNet, other, "app-net"})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0] != "db-fedcba9876543210:172.30.5.1" {
		t.Fatalf("ExtraHosts entries %v", entries)
	}
	merged := mergeManagedDatabaseExtraHosts([]string{"db-0123456789abcdef:172.30.4.1", "cache:10.0.0.3"}, entries)
	if strings.Join(merged, ",") != "cache:10.0.0.3,db-fedcba9876543210:172.30.5.1" {
		t.Fatalf("a recreate kept the host listener entry of a link the connector serves: %v", merged)
	}
}
