package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

// fakeRouterEngine is a Docker Engine API that lists one deployment: its router and its blue slot, running until the
// deployment operation stops it.
type fakeRouterEngine struct {
	t       *testing.T
	mu      sync.Mutex
	lists   int
	stopped bool
}

func (e *fakeRouterEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeRouterEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/containers/json") {
		e.t.Errorf("unexpected Docker API call %s %s", request.Method, request.URL.Path)
		return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
	}
	e.mu.Lock()
	e.lists++
	state := "running"
	if e.stopped {
		state = "exited"
	}
	e.mu.Unlock()
	labels := func(role, slot string) map[string]string {
		values := map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "deployment-1", deploymentRoleLabel: role}
		if slot != "" {
			values[deploymentSlotLabel] = slot
		}
		return values
	}
	list, _ := json.Marshal([]map[string]any{
		{"Id": "router-1", "Names": []string{"/app-router"}, "State": state, "Labels": labels("router", "")},
		{"Id": "blue-1", "Names": []string{"/app-blue"}, "State": state, "Labels": labels("app", "blue")},
	})
	return respond(http.StatusOK, string(list))
}

func (e *fakeRouterEngine) listCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lists
}

// A stop and deploy holds the deployment longer than the repair waits for it. The repair is not a failure then (no
// WARN for the expected wait): it looks at the deployment again once the operation is done.
func TestRouterRepairWaitsForTheRunningDeploymentOperation(t *testing.T) {
	engine := &fakeRouterEngine{t: t}
	logger, output := newTestLogger()
	plugin := &DockerPlugin{client: engine.client(), logger: logger}
	unlock, err := plugin.lockDeployment(context.Background(), "deployment-1")
	if err != nil {
		t.Fatal(err)
	}
	lock := func(ctx context.Context, deploymentID string) (func(), error) {
		lockCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		return plugin.lockDeployment(lockCtx, deploymentID)
	}
	repairs, waiting, err := plugin.client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, lock)
	if err != nil || len(repairs) != 0 || len(waiting) != 1 || waiting[0] != "deployment-1" {
		t.Fatalf("repair during the operation: repairs %v, waiting %v, error %v", repairs, waiting, err)
	}

	plugin.repairDeploymentRouterAfterOperation("deployment-1", "", deploymentRouterRepairScope{})
	// A later pass while the operation still runs adds no second waiter.
	plugin.repairDeploymentRouterAfterOperation("deployment-1", "", deploymentRouterRepairScope{})
	time.Sleep(50 * time.Millisecond)
	if calls := engine.listCalls(); calls != 1 {
		t.Fatalf("the repair looked at the deployment %d times while the operation held it", calls)
	}

	// The operation stops the deployment and lets go: the waiting repair finds nothing to bring back.
	engine.mu.Lock()
	engine.stopped = true
	engine.mu.Unlock()
	unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		plugin.deploymentOpMu.Lock()
		pending := plugin.routerRepairsWaiting["deployment-1"]
		plugin.deploymentOpMu.Unlock()
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the waiting repair did not run after the operation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if calls := engine.listCalls(); calls != 2 {
		t.Fatalf("the repair looked at the deployment %d times, want once after the operation", calls)
	}
	if lines := output.lines("level=WARN"); len(lines) != 0 {
		t.Fatalf("the expected wait was logged as a warning: %v", lines)
	}
}
