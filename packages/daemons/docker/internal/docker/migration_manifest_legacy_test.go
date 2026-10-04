package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

// docker-20.10-container-inspect.json is GET /containers/{id}/json as Docker
// Engine 20.10.24 writes it: types.ContainerJSON of github.com/docker/docker
// v20.10.24 marshalled, for a container started from nginx:alpine. Engine
// 20.10 reports HostConfig.KernelMemory and KernelMemoryTCP on every
// container, as 0; the API types of this daemon no longer have them.
func docker2010Inspect(t *testing.T, edit func(config, hostConfig map[string]any)) (string, string) {
	t.Helper()
	data, err := os.ReadFile("testdata/docker-20.10-container-inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	var inspect map[string]any
	if err := json.Unmarshal(data, &inspect); err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(inspect["Config"].(map[string]any), inspect["HostConfig"].(map[string]any))
	}
	data, _ = json.Marshal(inspect)
	return string(data), inspect["Image"].(string)
}

func docker2010Source(t *testing.T, inspect, imageID string, sizes *[]string) *Client {
	t.Helper()
	return fakeDockerEngine(t, func(request *http.Request, path string) (int, string) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
			*sizes = append(*sizes, request.URL.Query().Get("size"))
			return http.StatusOK, inspect
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/images/"+imageID+"/json"):
			return http.StatusOK, `{"Id":"` + imageID + `","Config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","NGINX_VERSION=1.27.2"]}}`
		}
		t.Errorf("unexpected source request %s %s", request.Method, path)
		return http.StatusInternalServerError, `{"message":"unexpected"}`
	})
}

// A container on Docker 20.10 reports both kernel memory fields as 0. They
// configure nothing, so the container migrates, and the preflight check
// agrees without asking Docker for the writable layer size.
func TestMigrationManifestAcceptsDocker2010InspectWithZeroKernelMemory(t *testing.T) {
	inspect, imageID := docker2010Inspect(t, nil)
	if !strings.Contains(inspect, `"KernelMemory":0`) || !strings.Contains(inspect, `"KernelMemoryTCP":0`) {
		t.Fatal("fixture lost the Docker 20.10 kernel memory fields")
	}
	var sizes []string
	source := docker2010Source(t, inspect, imageID, &sizes)

	manifest, err := source.CaptureMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Blockers) > 0 {
		t.Fatalf("blockers %v", manifest.Blockers)
	}
	validation, err := source.ValidateMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := json.Marshal(validation); string(data) != `{"blockers":[]}` {
		t.Fatalf("validation %s", data)
	}
	if want := []string{"1", ""}; !reflect.DeepEqual(sizes, want) {
		t.Fatalf("size query %q, want %q: the preflight check must not compute the layer size", sizes, want)
	}
}

// A set kernel memory limit or fixed MAC address cannot be carried to the
// target, so it blocks the migration with its reason, in the preflight check
// and in the capture alike. A field this daemon does not know still blocks.
func TestMigrationManifestBlocksSetLegacyCreateFields(t *testing.T) {
	inspect, imageID := docker2010Inspect(t, func(config, hostConfig map[string]any) {
		hostConfig["KernelMemoryTCP"] = 1048576
		config["MacAddress"] = "02:42:ac:11:00:02"
		hostConfig["FutureLimit"] = 0
	})
	var sizes []string
	source := docker2010Source(t, inspect, imageID, &sizes)

	want := []string{
		"unknown Docker create field HostConfig.FutureLimit",
		"unsupported Docker create field Config.MacAddress: the container has a fixed MAC address, which the migrated container cannot keep; remove it before migrating",
		"unsupported Docker create field HostConfig.KernelMemoryTCP: the container has a kernel TCP memory limit, which the migrated container cannot keep; remove it before migrating",
	}
	manifest, err := source.CaptureMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(manifest.Blockers, want) {
		t.Fatalf("capture blockers %q, want %q", manifest.Blockers, want)
	}
	validation, err := source.ValidateMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(validation.Blockers, want) {
		t.Fatalf("validation blockers %q, want %q", validation.Blockers, want)
	}
}

func TestZeroJSONValue(t *testing.T) {
	for raw, want := range map[string]bool{
		`null`: true, `0`: true, `""`: true, `false`: true, `[]`: true, `{}`: true,
		`1`: false, `-1`: false, `"x"`: false, `true`: false, `[0]`: false, `{"a":0}`: false,
	} {
		if got := zeroJSONValue(json.RawMessage(raw)); got != want {
			t.Errorf("zeroJSONValue(%s) = %v, want %v", raw, got, want)
		}
	}
}
