package docker

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// prepareSlotFakeDocker knows containers by name with their running state and
// records removals, creates and starts.
type prepareSlotFakeDocker struct {
	mu       sync.Mutex
	running  map[string]bool
	removed  []string
	created  map[string]container.CreateRequest
	started  []string
	sequence int
}

func (f *prepareSlotFakeDocker) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		path := r.URL.Path[strings.Index(r.URL.Path[1:], "/")+1:]
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json"):
			name := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
			running, ok := f.running[name]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"No such container"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": name + "-id", "Name": "/" + name, "State": map[string]any{"Running": running}})
		case r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
			name := strings.TrimPrefix(path, "/containers/")
			if _, ok := f.running[name]; !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"No such container"}`))
				return
			}
			delete(f.running, name)
			f.removed = append(f.removed, name)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/"):
			_, _ = w.Write([]byte(`{"Id":"sha256:image"}`))
		case r.Method == http.MethodPost && path == "/containers/create":
			var request container.CreateRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			f.sequence++
			name := r.URL.Query().Get("name")
			f.created[name] = request
			f.running[name] = false
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": name + "-id"})
		case r.Method == http.MethodPost && strings.HasSuffix(path, "/start"):
			f.started = append(f.started, strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/start"))
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected docker request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}
}

func prepareSlotPlugin(t *testing.T, running map[string]bool) (*DockerPlugin, *prepareSlotFakeDocker) {
	t.Helper()
	fake := &prepareSlotFakeDocker{running: running, created: map[string]container.CreateRequest{}}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	plugin := availabilityPluginForTest(t)
	plugin.client = &Client{cli: cli, logger: slog.Default()}
	plugin.deploymentOps = map[string]map[uint64]deploymentOperation{}
	return plugin, fake
}

func prepareSlotCommand(slot string) *pb.GatewayCommand {
	payload, _ := json.Marshal(map[string]any{
		"deployment": map[string]any{
			"id": "dep-1", "activeSlot": "blue", "routerName": "dep-1-router", "networkName": "dep-1-net",
			"slots": []map[string]any{{"slot": "blue", "containerName": "dep-1-blue"}, {"slot": "green", "containerName": "dep-1-green"}},
		},
		"toSlot":        slot,
		"desiredConfig": map[string]any{"image": "127.0.0.1:5443/gateway/availability/p/0/2:image", "env": map[string]string{"DATABASE_URL": "postgres://projected"}},
	})
	return &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerDeployment{DockerDeployment: &pb.DockerDeploymentCommand{
		Action: deploymentActionPrepareSlot, DeploymentId: "dep-1", ConfigJson: string(payload),
	}}}
}

func TestPrepareSlotCreatesTheInactiveColourWithoutStartingIt(t *testing.T) {
	plugin, fake := prepareSlotPlugin(t, map[string]bool{"dep-1-blue": true, "dep-1-green": false, "dep-1-router": true})
	result := plugin.HandleCommand(prepareSlotCommand("green"))
	if !result.Success {
		t.Fatalf("prepare_slot failed: %s", result.Error)
	}
	if len(fake.removed) != 1 || fake.removed[0] != "dep-1-green" {
		t.Fatalf("only the stopped inactive slot is replaced, removed %v", fake.removed)
	}
	created, ok := fake.created["dep-1-green"]
	if !ok || len(fake.created) != 1 {
		t.Fatalf("want exactly the green slot created, got %v", fake.created)
	}
	if created.Config.Image != "127.0.0.1:5443/gateway/availability/p/0/2:image" ||
		created.Config.Labels[deploymentSlotLabel] != "green" || created.Config.Labels[deploymentRoleLabel] != "app" {
		t.Fatalf("green slot created with the wrong config: %+v", created.Config)
	}
	if !strings.Contains(strings.Join(created.Config.Env, ","), "DATABASE_URL=postgres://projected") {
		t.Fatalf("the prepared slot must carry the projected environment, env %v", created.Config.Env)
	}
	if len(fake.started) != 0 {
		t.Fatalf("prepare_slot must never start anything, started %v", fake.started)
	}
	if !fake.running["dep-1-blue"] {
		t.Fatal("the serving blue slot must keep running")
	}
	var detail map[string]string
	if err := json.Unmarshal([]byte(result.Detail), &detail); err != nil || detail["containerId"] != "dep-1-green-id" {
		t.Fatalf("detail %q, want the created container id", result.Detail)
	}
}

func TestPrepareSlotNeverReplacesARunningSlot(t *testing.T) {
	plugin, fake := prepareSlotPlugin(t, map[string]bool{"dep-1-blue": true, "dep-1-router": true})
	result := plugin.HandleCommand(prepareSlotCommand("blue"))
	if result.Success || !strings.Contains(result.Error, errPrepareOverRunningSlot.Error()) {
		t.Fatalf("prepare_slot over the running slot must fail, got %+v", result)
	}
	if len(fake.removed) != 0 || len(fake.created) != 0 || len(fake.started) != 0 {
		t.Fatalf("a refused prepare changes nothing, removed %v created %v started %v", fake.removed, fake.created, fake.started)
	}
}

func TestPrepareSlotCreatesAMissingSlot(t *testing.T) {
	plugin, fake := prepareSlotPlugin(t, map[string]bool{"dep-1-blue": true, "dep-1-router": true})
	if result := plugin.HandleCommand(prepareSlotCommand("green")); !result.Success {
		t.Fatalf("prepare_slot of a missing slot failed: %s", result.Error)
	}
	if _, ok := fake.created["dep-1-green"]; !ok || len(fake.started) != 0 {
		t.Fatalf("want the green slot created and not started, created %v started %v", fake.created, fake.started)
	}
}
