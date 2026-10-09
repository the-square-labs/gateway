package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

func TestSeaweedFSContainersGetTheReceiveBuffers(t *testing.T) {
	if got := seaweedfsSysctls()["net.ipv4.tcp_rmem"]; got != "4096 2097152 16777216" {
		t.Fatalf("tcp_rmem = %q", got)
	}
	if !seaweedfsSysctlsOutdated(nil) || !seaweedfsSysctlsOutdated(map[string]string{"net.ipv4.tcp_rmem": "4096 131072 6291456"}) {
		t.Fatal("a container without the receive buffers counts as current")
	}
	if seaweedfsSysctlsOutdated(seaweedfsSysctls()) {
		t.Fatal("a current container counts as outdated")
	}
}

// The engine's Go heap may use 60 % of the container's memory, and the volume
// server holds at most an eighth of it per direction in transfers, so 1 GiB
// objects and many small ones next to them fit the default 768 MiB (F-4b).
func TestSeaweedFSMemoryBounds(t *testing.T) {
	record := managedStorageRecord{MemoryBytes: 768 * mebibyte, StorageBytes: 14 * gibibyte}
	if got := seaweedfsMemoryLimitEnv(record.MemoryBytes); got != "GOMEMLIMIT=460MiB" {
		t.Fatalf("memory limit %s", got)
	}
	command := seaweedfsCommand(record)
	for _, flag := range []string{"-volume.concurrentUploadLimitMB=96", "-volume.concurrentDownloadLimitMB=96", "-filer.maxMB=1"} {
		if !slices.Contains(command, flag) {
			t.Fatalf("command %v lacks %s", command, flag)
		}
	}
	if got := seaweedfsTransferLimitMiB(128 * mebibyte); got != 32 {
		t.Fatalf("transfer limit of a small container %d, want the 32 MiB floor", got)
	}
}

// A container an older daemon made (other flags, the 85 % heap limit, no
// receive buffers) is outdated, so an update, a restart or the supervisor
// after an unrequested stop recreates it; a current one is not.
func TestSeaweedFSContainerOutdated(t *testing.T) {
	record := managedStorageRecord{ContainerID: "s1", Engine: managedStorageEngineSeaweedFS, MemoryBytes: 768 * mebibyte, StorageBytes: 14 * gibibyte}
	current := map[string]any{
		"Config":     map[string]any{"Cmd": seaweedfsCommand(record), "Env": []string{seaweedfsMemoryLimitEnv(record.MemoryBytes), "PATH=/usr/bin"}},
		"HostConfig": map[string]any{"Sysctls": seaweedfsSysctls()},
	}
	for _, tc := range []struct {
		name     string
		change   func(map[string]any)
		outdated bool
	}{
		{"current", func(map[string]any) {}, false},
		{"old heap limit", func(c map[string]any) {
			c["Config"] = map[string]any{"Cmd": seaweedfsCommand(record), "Env": []string{"GOMEMLIMIT=652MiB"}}
		}, true},
		{"old flags", func(c map[string]any) {
			c["Config"] = map[string]any{"Cmd": []string{"server", "-dir=/data"}, "Env": []string{seaweedfsMemoryLimitEnv(record.MemoryBytes)}}
		}, true},
		{"no receive buffers", func(c map[string]any) { c["HostConfig"] = map[string]any{} }, true},
		{"nothing to judge", func(c map[string]any) { c["Config"] = map[string]any{} }, false},
	} {
		inspect := map[string]any{"Id": "s1", "State": map[string]any{"Running": true}}
		for key, value := range current {
			inspect[key] = value
		}
		tc.change(inspect)
		raw, _ := json.Marshal(inspect)
		cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
			client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
			})}))
		if err != nil {
			t.Fatal(err)
		}
		m := &managedStorageManager{client: &Client{cli: cli}}
		if got := m.seaweedfsContainerOutdated(context.Background(), record); got != tc.outdated {
			t.Fatalf("%s: outdated %v, want %v", tc.name, got, tc.outdated)
		}
	}
}
