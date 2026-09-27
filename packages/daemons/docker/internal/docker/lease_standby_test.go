package docker

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// standbyFakeDocker records creates and starts; every start of an app
// container is a failure of the standby contract.
type standbyFakeDocker struct {
	mu       sync.Mutex
	listed   []map[string]any
	labels   map[string]map[string]string
	created  map[string]container.CreateRequest
	started  []string
	sequence int
}

func (f *standbyFakeDocker) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		path := r.URL.Path[strings.Index(r.URL.Path[1:], "/")+1:]
		switch {
		case r.Method == http.MethodGet && path == "/containers/json":
			_ = json.NewEncoder(w).Encode(f.listed)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json"):
			id := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
			labels, ok := f.labels[id]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"No such container"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}})
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/"):
			_, _ = w.Write([]byte(`{"Id":"sha256:image"}`))
		case r.Method == http.MethodPost && path == "/networks/create":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"Id":"network"}`))
		case r.Method == http.MethodPost && path == "/containers/create":
			var request container.CreateRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			f.sequence++
			id := fmt.Sprintf("%s-%d", r.URL.Query().Get("name"), f.sequence)
			f.created[id] = request
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": id})
		case r.Method == http.MethodPost && strings.HasSuffix(path, "/start"):
			f.started = append(f.started, strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/start"))
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected docker request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}
}

func newStandbyFakeDocker(t *testing.T) (*standbyFakeDocker, *Client) {
	t.Helper()
	fake := &standbyFakeDocker{labels: map[string]map[string]string{}, created: map[string]container.CreateRequest{}}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return fake, &Client{cli: cli, logger: slog.Default()}
}

func standbyDeploymentCommand(t *testing.T) *pb.GatewayCommand {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"deploymentId": "dep-1", "activeSlot": "green", "routerName": "dep-1-router", "networkName": "dep-1-net",
		"slots":         map[string]string{"blue": "dep-1-blue", "green": "dep-1-green"},
		"routes":        []map[string]any{{"hostPort": 8080, "containerPort": 80, "isPrimary": true}},
		"desiredConfig": map[string]any{"image": "app:1", "restartPolicy": "unless-stopped", "runtime": map[string]any{"restartPolicy": "always"}, "labels": map[string]string{availabilityPolicyLabel: "policy-1"}},
	})
	return &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerDeployment{DockerDeployment: &pb.DockerDeploymentCommand{
		Action: deploymentActionCreateStandby, DeploymentId: "dep-1", ConfigJson: string(payload),
	}}}
}

func TestDeploymentCreateStandbyCreatesAndNeverStartsTheApp(t *testing.T) {
	plugin := leasePluginForTest(t)
	fake, dockerClient := newStandbyFakeDocker(t)
	plugin.client = dockerClient
	plugin.deploymentOps = map[string]map[uint64]deploymentOperation{}
	command := standbyDeploymentCommand(t)
	if err := plugin.leaseGate(command); err != nil {
		t.Fatalf("create_standby must pass the lease gate on a non-holder: %v", err)
	}
	result := plugin.HandleCommand(command)
	if !result.Success {
		t.Fatalf("create_standby failed: %s", result.Error)
	}
	var apps, routers int
	for id, request := range fake.created {
		switch request.Config.Labels[deploymentRoleLabel] {
		case "app":
			apps++
			if request.HostConfig.RestartPolicy.Name != container.RestartPolicyDisabled {
				t.Fatalf("standby slot %s restart policy %q, want no (A2.1)", id, request.HostConfig.RestartPolicy.Name)
			}
			for _, started := range fake.started {
				if started == id {
					t.Fatalf("create_standby started the app slot %s", id)
				}
			}
		case "router":
			routers++
		}
	}
	if apps != 2 || routers != 1 || len(fake.started) != 1 || !strings.HasPrefix(fake.started[0], "dep-1-router") {
		t.Fatalf("want 2 stopped slots and a started router, created %d/%d started %v", apps, routers, fake.started)
	}

	// Never over a running copy: the holder's app must not be replaced.
	fake.listed = []map[string]any{{"Id": "running", "State": "running", "Labels": map[string]string{deploymentIDLabel: "dep-1", deploymentRoleLabel: "app"}}}
	if result := plugin.HandleCommand(standbyDeploymentCommand(t)); result.Success || !strings.Contains(result.Error, errStandbyOverRunningCopy.Error()) {
		t.Fatalf("create_standby over a running app must fail, got %+v", result)
	}
}

func TestComposePullCreatePullsAndCreatesWithoutStarting(t *testing.T) {
	if !isComposeAction(composeActionPullCreate) {
		t.Fatal("pull_create must be a compose action")
	}
	commands, err := composeSidecarCommands(composeRequest{action: composeActionPullCreate, removeOrphans: true})
	want := [][]string{{"pull"}, {"create", "--no-build", "--pull", "never", "--remove-orphans"}}
	if err != nil || !reflect.DeepEqual(commands, want) {
		t.Fatalf("pull_create commands %v err %v, want %v", commands, err, want)
	}
	for _, command := range commands {
		if command[0] == "up" || command[0] == "start" || command[0] == "restart" {
			t.Fatalf("pull_create must never start services: %v", commands)
		}
	}
	fake, dockerClient := newStandbyFakeDocker(t)
	fake.listed = []map[string]any{{"Id": "svc", "State": "running", "Labels": map[string]string{composeProjectLabel: "shop"}}}
	running, err := dockerClient.composeProjectRunning(t.Context(), "shop")
	if err != nil || !running {
		t.Fatalf("running compose project not detected: %v %v", running, err)
	}
}

func TestLeaseGateMatrixForNonHolder(t *testing.T) {
	plugin := leasePluginForTest(t)
	fake, dockerClient := newStandbyFakeDocker(t)
	plugin.client = dockerClient
	fake.labels["lease-c"] = map[string]string{availabilityPolicyLabel: "policy-1"}
	if _, err := plugin.availability.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: "policy-1", PlacementId: "p-compose", Generation: 1, IdempotencyKey: "c",
		ResourceKind: "compose", ResourceId: "project-1",
	}); err != nil {
		t.Fatal(err)
	}
	container := func(action, config string) *pb.GatewayCommand {
		return &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: action, ContainerId: "lease-c", ConfigJson: config}}}
	}
	availability := func(action, config string) *pb.GatewayCommand {
		command := availabilityCommand(action, 1, action, "op", config)
		return availabilityGatewayCommand(command)
	}
	deployment := func(action string) *pb.GatewayCommand {
		return &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerDeployment{DockerDeployment: &pb.DockerDeploymentCommand{Action: action, DeploymentId: "dep-1",
			ConfigJson: `{"desiredConfig":{"labels":{"` + availabilityPolicyLabel + `":"policy-1"}}}`}}}
	}
	compose := func(action string) *pb.GatewayCommand {
		return &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: &pb.DockerComposeCommand{Action: action, ProjectId: "project-1"}}}
	}
	allowed := map[string]*pb.GatewayCommand{
		"container create":          container("create", `{"image":"x","labels":{"`+availabilityPolicyLabel+`":"policy-1"}}`),
		"container live_update no":  container("live_update", `{"restartPolicy":"no"}`),
		"container remove":          container("remove", ""),
		"availability prepare":      availability(availabilityActionPrepare, `{"phase":"standby","runtimeIdentity":{"containerId":"lease-c"}}`),
		"availability inspect":      availability(availabilityActionInspect, ""),
		"availability remove":       availability(availabilityActionRemove, ""),
		"deployment inspect":        deployment("inspect"),
		"deployment remove":         deployment("remove"),
		"deployment create_standby": deployment(deploymentActionCreateStandby),
		"compose down":              compose("down"),
		"compose pull_create":       compose(composeActionPullCreate),
	}
	for name, command := range allowed {
		if err := plugin.leaseGate(command); err != nil {
			t.Errorf("%s must be allowed for a lease-mode placement: %v", name, err)
		}
	}
	refused := map[string]*pb.GatewayCommand{
		"container start":              container("start", ""),
		"container restart":            container("restart", ""),
		"container live_update always": container("live_update", `{"restartPolicy":"always"}`),
		"availability activate":        availability(availabilityActionActivate, ""),
		"availability adopt_single":    availability(availabilityActionAdoptSingle, ""),
		"deployment start":             deployment("start"),
		"deployment create":            deployment("create"),
		"compose start":                compose("start"),
		"compose pull_apply":           compose("pull_apply"),
	}
	for name, command := range refused {
		if err := plugin.leaseGate(command); err == nil {
			t.Errorf("%s must be refused without the lease (A5)", name)
		} else if name != "container live_update always" && !errors.Is(err, lease.ErrLeaseNotHeld) {
			t.Errorf("%s refused for the wrong reason: %v", name, err)
		}
	}
}

func TestStandbyPrepareIsNeverStartedAndTracksTheLease(t *testing.T) {
	plugin := availabilityPluginForTest(t)
	prepare := availabilityCommand(availabilityActionPrepare, 3, "op:standby", "op",
		`{"phase":"standby","runtimeIdentity":{"containerId":"c1","containerName":"app-standby"}}`)
	result := plugin.HandleCommand(availabilityGatewayCommand(prepare))
	if !result.Success {
		t.Fatal(result.Error)
	}
	if state := decodeAvailabilityDetail(t, result.Detail); state.State != availabilityLifecyclePrepared || state.Generation != 3 ||
		state.RuntimeIdentity["containerName"] != "app-standby" {
		t.Fatalf("standby prepare state %+v", state)
	}
	// Acquisition marks it active, a confirmed stop marks it stopped.
	if err := plugin.availability.markLeaseLifecycle("policy-1", true); err != nil {
		t.Fatal(err)
	}
	replay := plugin.HandleCommand(availabilityGatewayCommand(prepare))
	if !replay.Success || decodeAvailabilityDetail(t, replay.Detail).State != availabilityLifecycleActive {
		t.Fatalf("an idempotent replay must report the current state: %+v", replay)
	}
	if err := plugin.availability.markLeaseLifecycle("policy-1", false); err != nil {
		t.Fatal(err)
	}
	placement, _ := availabilityPlacementForTest(plugin.availability, "policy-1", "placement-1")
	if placement.LifecycleState != availabilityLifecycleStopped || placement.HighestGeneration != 3 {
		t.Fatalf("released standby placement %+v, want stopped at generation 3", placement)
	}
}
