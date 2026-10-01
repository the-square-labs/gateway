package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/client"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

// fakeDeploymentEngine is a Docker Engine API with every slot running and attached to no network, so readiness can
// never pass. It records the containers stopped.
type fakeDeploymentEngine struct {
	t       *testing.T
	mu      sync.Mutex
	stopped []string
}

var fakeEngineContainerPath = regexp.MustCompile(`^/v[0-9.]+/containers/([^/]+)(/[a-z]+)?$`)

func (e *fakeDeploymentEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeDeploymentEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	switch {
	case request.Method == http.MethodGet && strings.Contains(path, "/images/"):
		return respond(http.StatusOK, `{"Id":"sha256:0123"}`)
	case request.Method == http.MethodPost && strings.HasSuffix(path, "/containers/create"):
		return respond(http.StatusCreated, `{"Id":"`+request.URL.Query().Get("name")+`"}`)
	}
	match := fakeEngineContainerPath.FindStringSubmatch(path)
	if match == nil {
		e.t.Errorf("unexpected Docker API call %s %s", request.Method, path)
		return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
	}
	name, action := match[1], match[2]
	switch {
	case request.Method == http.MethodGet && action == "/json":
		inspect, _ := json.Marshal(map[string]any{"Id": name, "Name": "/" + name, "State": map[string]any{"Running": true, "Status": "running"},
			"NetworkSettings": map[string]any{"Networks": map[string]any{}}})
		return respond(http.StatusOK, string(inspect))
	case request.Method == http.MethodPost && action == "/stop":
		e.mu.Lock()
		e.stopped = append(e.stopped, name)
		e.mu.Unlock()
		return respond(http.StatusNoContent, "")
	case request.Method == http.MethodPost && action == "/start", request.Method == http.MethodDelete && action == "":
		return respond(http.StatusNoContent, "")
	}
	e.t.Errorf("unexpected Docker API call %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

func (e *fakeDeploymentEngine) stoppedContainers() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.stopped...)
}

func deploymentCandidatePayload(t *testing.T, activeSlot, target string, desiredImage string) deploymentCommandPayload {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"deploymentId": "deployment-1",
		"activeSlot":   target,
		"toSlot":       target,
		"desiredConfig": map[string]any{
			"image": desiredImage,
		},
		"deployment": map[string]any{
			"id": "deployment-1", "routerName": "app-router", "networkName": "app-net", "activeSlot": activeSlot,
			"routes":       []map[string]any{{"hostPort": 8080, "containerPort": 8080, "isPrimary": true}},
			"healthConfig": map[string]any{"intervalSeconds": 1, "deployTimeoutSeconds": 1},
			"slots":        []map[string]any{{"slot": "blue", "containerName": "app-blue"}, {"slot": "green", "containerName": "app-green"}},
		},
	})
	var payload deploymentCommandPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

// A rollout candidate that fails readiness is stopped and kept: crash-looping, it would keep taking the sessions its
// database and storage links share with the slot that serves.
func TestFailedRolloutCandidateIsStopped(t *testing.T) {
	for _, action := range []string{"switch", "deploy_slot"} {
		t.Run(action, func(t *testing.T) {
			engine := &fakeDeploymentEngine{t: t}
			docker := engine.client()
			var err error
			switch action {
			case "switch":
				_, err = docker.SwitchDeployment(context.Background(), deploymentCandidatePayload(t, "blue", "green", ""))
			case "deploy_slot":
				_, err = docker.DeployDeploymentSlot(context.Background(), deploymentCandidatePayload(t, "blue", "green", "app:2"))
			}
			if err == nil || !strings.Contains(err.Error(), "readiness timed out") || !strings.Contains(err.Error(), "green slot was stopped") {
				t.Fatalf("failed candidate returned %v", err)
			}
			if stopped := engine.stoppedContainers(); len(stopped) != 1 || stopped[0] != "app-green" {
				t.Fatalf("stopped %v, want the candidate app-green", stopped)
			}
		})
	}
}

// The slot the router serves is never stopped for failing readiness.
func TestServingSlotIsNotStoppedOnFailedReadiness(t *testing.T) {
	engine := &fakeDeploymentEngine{t: t}
	_, err := engine.client().SwitchDeployment(context.Background(), deploymentCandidatePayload(t, "blue", "blue", ""))
	if err == nil || strings.Contains(err.Error(), "stopped") {
		t.Fatalf("switch to the serving slot returned %v", err)
	}
	if stopped := engine.stoppedContainers(); len(stopped) != 0 {
		t.Fatalf("serving slot stopped: %v", stopped)
	}
}
