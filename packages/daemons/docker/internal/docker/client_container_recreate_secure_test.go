package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

// A recreate that does not name a runtime profile keeps the container's runtime: a Secure Runtime (runsc) container
// is refused a GPU before anything is stopped or removed, as a create that selects Secure Runtime is.
func TestRecreateOfSecureRuntimeContainerRefusesGPU(t *testing.T) {
	var changes []string
	respond := func(request *http.Request, code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	serve := func(request *http.Request) (*http.Response, error) {
		path, _ := url.PathUnescape(request.URL.Path)
		if request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/sec1/json") {
			inspect, _ := json.Marshal(map[string]any{
				"Id": "secure-runtime", "Name": "/sec1", "Image": "sha256:app",
				"State":           map[string]any{"Status": "running", "Running": true},
				"Config":          map[string]any{"Image": "app:1"},
				"HostConfig":      map[string]any{"Runtime": "runsc", "NetworkMode": "bridge"},
				"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]any{}}},
			})
			return respond(request, http.StatusOK, string(inspect))
		}
		changes = append(changes, request.Method+" "+path)
		return respond(request, http.StatusInternalServerError, `{"message":"unexpected"}`)
	}
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(serve)}))
	if err != nil {
		t.Fatal(err)
	}

	err = (&Client{cli: cli}).RecreateWithConfig(context.Background(), "sec1", `{"gpu":{"deviceIds":["0"]}}`)

	if err == nil || !strings.Contains(err.Error(), "Secure Runtime does not support GPU attachments") {
		t.Fatalf("recreate error = %v", err)
	}
	if len(changes) > 0 {
		t.Fatalf("recreate called Docker before refusing: %v", changes)
	}
}
