package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

// databaseContainerListClient is a Docker Engine API that lists one managed
// database container labelled with id, or fails the list.
func databaseContainerListClient(t *testing.T, id string, listFails bool) *Client {
	t.Helper()
	serve := func(request *http.Request) (*http.Response, error) {
		reply := func(code int, body any) (*http.Response, error) {
			raw, _ := json.Marshal(body)
			return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
		}
		match := fakeEngineContainerPath.FindStringSubmatch(request.URL.Path)
		if match == nil || match[1] != "json" || request.Method != http.MethodGet {
			t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
			return reply(http.StatusNotFound, map[string]string{"message": "not found"})
		}
		if listFails {
			return reply(http.StatusInternalServerError, map[string]string{"message": "Docker is restarting"})
		}
		return reply(http.StatusOK, []map[string]any{{
			"Id": "c-" + id, "Names": []string{"/gwdb-" + id}, "Labels": map[string]string{managedDatabaseLabel: id},
		}})
	}
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(serve)}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

// The repair pass keeps the image, mount and loop device of a database whose
// container outlived its record: they hold the data a retried create takes
// over. When the containers cannot be listed it releases no database storage.
func TestDatabaseRepairKeepsTheStorageOfAContainerWithoutARecord(t *testing.T) {
	for _, tc := range []struct {
		name         string
		listFails    bool
		orphanKept   bool
		orphanReason string
	}{
		{name: "containers listed", orphanReason: "an image without a record or a container is released"},
		{name: "list fails", listFails: true, orphanKept: true, orphanReason: "nothing is released while the containers are unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			loops := newFakeLoops(t)
			m := newTestDatabaseManager(t, loops)
			m.client = databaseContainerListClient(t, "kept", tc.listFails)
			keptImage := filepath.Join(m.root, "images", "kept.img")
			keptMount := filepath.Join(m.root, "mounts", "kept")
			writeFile(t, keptImage)
			if err := os.MkdirAll(keptMount, 0o700); err != nil {
				t.Fatal(err)
			}
			loops.attach("/dev/loop1", "7:1", keptImage)
			loops.mount("7:1", keptMount)
			orphanImage := filepath.Join(m.root, "images", "orphan.img")
			writeFile(t, orphanImage)

			m.repairLoopImages(context.Background())

			if !exists(keptImage) || !loops.bound("/dev/loop1") {
				t.Fatalf("repair released the storage of a database whose container is still on the node (calls %v)", loops.calls)
			}
			for _, call := range loops.calls {
				if strings.Contains(call, "kept") || strings.Contains(call, "/dev/loop1") {
					t.Fatalf("repair touched the kept database: %v", loops.calls)
				}
			}
			if exists(orphanImage) != tc.orphanKept {
				t.Fatalf("orphan image kept = %v, want %v: %s", exists(orphanImage), tc.orphanKept, tc.orphanReason)
			}
		})
	}
}
