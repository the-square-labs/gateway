package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

const (
	originContainerID = "98e61452572cf42af6cba90ed3870c3dc448d95e43f6e0152a7a530c38ea9430"
	otherContainerID  = "cf0982c73525b600c66cd0a8c1a93c6b59eb0e4aea6063946492a9e002dd8b54"
)

func recordPlacementRuntime(t *testing.T, manager *availabilityManager, policyID, placementID, kind, resourceID string, generation uint64, identity map[string]any) {
	t.Helper()
	config, _ := json.Marshal(map[string]any{"phase": "standby", "runtimeIdentity": identity})
	if _, err := manager.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: policyID, PlacementId: placementID, Generation: generation,
		IdempotencyKey: placementID + ":prepare", ResourceKind: kind, ResourceId: resourceID, ConfigJson: string(config),
	}); err != nil {
		t.Fatal(err)
	}
}

// Stand run rc20 B-1/B-2: an origin container adopted without recreation and
// an origin deployment's slot containers carry no availability labels, so the
// lease never saw them as the slot's workload. Their placements recorded them.
func TestLeaseRuntimeIdentitiesMapUnlabeledOriginWorkloads(t *testing.T) {
	manager := availabilityManagerForTest(t)
	recordPlacementRuntime(t, manager, "policy-container", "placement-origin", "container", "hafo", 1,
		map[string]any{"containerId": originContainerID, "containerName": "hafo"})
	recordPlacementRuntime(t, manager, "policy-deployment", "placement-orders", "deployment", "dep-orders", 1,
		map[string]any{"deploymentId": "dep-orders", "activeSlot": "blue", "routerName": "gwdep-orders-router",
			"slots": map[string]any{"blue": "gwdep-orders-blue", "green": "gwdep-orders-green"}})
	// A tombstoned placement's runtime is nobody's workload any more.
	recordPlacementRuntime(t, manager, "policy-gone", "placement-gone", "container", "gone", 1,
		map[string]any{"containerId": otherContainerID, "containerName": "gone"})
	if _, err := manager.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionRemove, PolicyId: "policy-gone", PlacementId: "placement-gone", Generation: 2,
		IdempotencyKey: "gone:remove", ResourceKind: "container", ResourceId: "gone",
	}); err != nil {
		t.Fatal(err)
	}
	identities := manager.leaseRuntimeIdentities()

	if placement, ok := identities.match(originContainerID, []string{"/hafo"}, map[string]string{}); !ok || placement.PolicyID != "policy-container" || placement.PlacementID != "placement-origin" {
		t.Fatalf("origin container: %+v ok=%v", placement, ok)
	}
	app := func(slot string) map[string]string {
		return map[string]string{deploymentIDLabel: "dep-orders", deploymentRoleLabel: "app", deploymentSlotLabel: slot}
	}
	for _, slot := range []string{"blue", "green"} {
		if placement, ok := identities.match("any-id-"+slot, []string{"/gwdep-orders-" + slot}, app(slot)); !ok || placement.PolicyID != "policy-deployment" {
			t.Fatalf("origin deployment %s slot: %+v ok=%v", slot, placement, ok)
		}
	}
	if _, ok := identities.match("router-id", []string{"/gwdep-orders-router"}, map[string]string{deploymentIDLabel: "dep-orders", deploymentRoleLabel: "router"}); ok {
		t.Fatal("the deployment router is not lease-governed")
	}
	if _, ok := identities.match("impostor", []string{"/gwdep-orders-blue"}, map[string]string{deploymentIDLabel: "other", deploymentRoleLabel: "app"}); ok {
		t.Fatal("a slot name of another deployment must not map")
	}
	if _, ok := identities.match(originContainerID, []string{"/hafo"}, map[string]string{availabilityPolicyLabel: "policy-other"}); ok {
		t.Fatal("a container labeled for a policy belongs to that policy")
	}
	if _, ok := identities.match(otherContainerID, []string{"/gone"}, map[string]string{}); ok {
		t.Fatal("a tombstoned placement's runtime must not map")
	}
	if _, ok := identities.match(otherContainerID, []string{"/hafo"}, map[string]string{}); ok {
		t.Fatal("a container placement that recorded an ID is matched by that ID only, never by name")
	}
}

// leaseEngineDocker answers the Docker API calls ListLeaseContainers makes.
type leaseEngineDocker struct {
	containers []leaseEngineContainer
}

type leaseEngineContainer struct {
	id, name string
	labels   map[string]string
	running  bool
}

func (d *leaseEngineDocker) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path[strings.Index(r.URL.Path[1:], "/")+1:]
		switch {
		case path == "/info":
			_ = json.NewEncoder(w).Encode(map[string]any{"CgroupDriver": "systemd", "CgroupVersion": "2"})
		case path == "/containers/json":
			var filters map[string]map[string]bool
			_ = json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters)
			var items []map[string]any
			for _, c := range d.containers {
				if keep := labelFilterMatches(filters["label"], c.labels); keep {
					items = append(items, map[string]any{"Id": c.id, "Names": []string{"/" + c.name}, "Labels": c.labels})
				}
			}
			_ = json.NewEncoder(w).Encode(items)
		case strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json"):
			id := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
			for _, c := range d.containers {
				if c.id == id || c.name == id {
					status := "exited"
					if c.running {
						status = "running"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{
						"Id": c.id, "Name": "/" + c.name, "Config": map[string]any{"Labels": c.labels},
						"State":      map[string]any{"Running": c.running, "Status": status},
						"HostConfig": map[string]any{"RestartPolicy": map[string]any{"Name": "no"}},
					})
					return
				}
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"No such container"}`))
		default:
			t.Errorf("unexpected docker request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
}

// labelFilterMatches applies Docker's "label" list filter: every key (or
// key=value) must be present.
func labelFilterMatches(wanted map[string]bool, labels map[string]string) bool {
	for filter := range wanted {
		key, value, hasValue := strings.Cut(filter, "=")
		actual, ok := labels[key]
		if !ok || (hasValue && actual != value) {
			return false
		}
	}
	return true
}

func TestLeaseEngineListsUnlabeledOriginRuntimesAsTheirPlacement(t *testing.T) {
	manager := availabilityManagerForTest(t)
	recordPlacementRuntime(t, manager, "policy-container", "placement-origin", "container", "hafo", 1,
		map[string]any{"containerId": originContainerID, "containerName": "hafo"})
	recordPlacementRuntime(t, manager, "policy-deployment", "placement-orders", "deployment", "dep-orders", 1,
		map[string]any{"deploymentId": "dep-orders", "activeSlot": "blue",
			"slots": map[string]any{"blue": "gwdep-orders-blue", "green": "gwdep-orders-green"}})
	docker := &leaseEngineDocker{containers: []leaseEngineContainer{
		{id: originContainerID, name: "hafo", labels: map[string]string{"maintainer": "someone"}, running: true},
		{id: "blue-id", name: "gwdep-orders-blue", running: true,
			labels: map[string]string{deploymentIDLabel: "dep-orders", deploymentRoleLabel: "app", deploymentSlotLabel: "blue"}},
		{id: "green-id", name: "gwdep-orders-green",
			labels: map[string]string{deploymentIDLabel: "dep-orders", deploymentRoleLabel: "app", deploymentSlotLabel: "green"}},
		{id: "router-id", name: "gwdep-orders-router", running: true,
			labels: map[string]string{deploymentIDLabel: "dep-orders", deploymentRoleLabel: "router"}},
		{id: "labeled-id", name: "gwav-container-policy-l", running: true,
			labels: map[string]string{availabilityPolicyLabel: "policy-labeled", availabilityPlacementLabel: "placement-l"}},
		{id: "unrelated-id", name: "docs", running: true, labels: map[string]string{}},
	}}
	server := docker.server(t)
	t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	engine := &leaseEngine{client: &Client{cli: cli}, cgroupRoot: t.TempDir(), runtimeIdentities: manager.leaseRuntimeIdentities}

	listed, err := engine.ListLeaseContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]lease.Container{}
	for _, c := range listed {
		got[c.ID] = c
	}
	want := map[string][2]string{
		originContainerID: {"policy-container", "placement-origin"},
		"blue-id":         {"policy-deployment", "placement-orders"},
		"green-id":        {"policy-deployment", "placement-orders"},
		"labeled-id":      {"policy-labeled", "placement-l"},
	}
	if len(got) != len(want) {
		t.Fatalf("listed %d containers, want %d: %+v", len(got), len(want), listed)
	}
	for id, owner := range want {
		c, ok := got[id]
		if !ok || c.PolicyID != owner[0] || c.PlacementID != owner[1] {
			t.Fatalf("container %s: %+v ok=%v, want policy %s placement %s", id, c, ok, owner[0], owner[1])
		}
	}
	if !got[originContainerID].Running || got[originContainerID].Name != "hafo" {
		t.Fatalf("origin container view %+v", got[originContainerID])
	}
}

// The start gate maps an unlabeled origin container to its policy, so a
// backend or user start of it needs the lease like any other copy (A5).
func TestStartGateCoversAnUnlabeledOriginContainer(t *testing.T) {
	plugin, fake := hookedPluginForTest(t)
	recordPlacementRuntime(t, plugin.availability, "policy-1", "placement-origin", "container", "hafo", 1,
		map[string]any{"containerId": originContainerID, "containerName": "hafo"})
	fake.labels[originContainerID] = map[string]string{"maintainer": "someone"}
	fake.labels["unrelated"] = map[string]string{}

	if err := plugin.client.StartContainer(context.Background(), originContainerID); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("origin container start without the lease: %v", err)
	}
	gate := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "start", ContainerId: originContainerID}}}
	if err := plugin.leaseGate(gate); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("dispatch gate for the origin container: %v", err)
	}
	if err := plugin.client.StartContainer(context.Background(), "unrelated"); err != nil {
		t.Fatalf("a container of no placement keeps starting: %v", err)
	}
	if len(fake.started) != 1 || fake.started[0] != "unrelated" {
		t.Fatalf("started %v", fake.started)
	}
}
