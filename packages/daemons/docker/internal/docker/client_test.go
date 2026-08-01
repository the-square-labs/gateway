package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func writeDockerLogFrame(t *testing.T, buf *bytes.Buffer, payload string) {
	t.Helper()
	header := make([]byte, 8)
	header[0] = 1
	binary.BigEndian.PutUint32(header[4:8], uint32(len(payload)))
	if _, err := buf.Write(header); err != nil {
		t.Fatalf("write header: %v", err)
	}
	if _, err := buf.WriteString(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
}

func TestContainerCreateConfigParsesRestartPolicyFromCamelCase(t *testing.T) {
	var cfg ContainerCreateConfig
	if err := json.Unmarshal([]byte(`{"image":"nginx:latest","restartPolicy":"always"}`), &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}

	if cfg.RestartPolicy != "always" {
		t.Fatalf("restart policy = %q", cfg.RestartPolicy)
	}
	if cfg.effectiveRestartPolicy() != "always" {
		t.Fatalf("effective restart policy = %q", cfg.effectiveRestartPolicy())
	}
}

func TestParseDockerLogsBoundedKeepsLastLines(t *testing.T) {
	var buf bytes.Buffer
	writeDockerLogFrame(t, &buf, "one\ntwo\n")
	writeDockerLogFrame(t, &buf, "three\nfour\n")

	lines, err := parseDockerLogsBounded(&buf, 2, maxDockerLogReadBytes)
	if err != nil {
		t.Fatalf("parse logs: %v", err)
	}

	if got, want := strings.Join(lines, ","), "three,four"; got != want {
		t.Fatalf("lines = %q, want %q", got, want)
	}
}

func TestParseDockerLogsBoundedRejectsOversizedResponses(t *testing.T) {
	var buf bytes.Buffer
	writeDockerLogFrame(t, &buf, "first\n")
	writeDockerLogFrame(t, &buf, "second\n")

	_, err := parseDockerLogsBounded(&buf, 10, 8)
	if !errors.Is(err, errDockerLogsTooLarge) {
		t.Fatalf("error = %v, want errDockerLogsTooLarge", err)
	}
}

func TestContainerLogsFollowDoesNotReplayAllHistoryByDefault(t *testing.T) {
	var logsQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1.43/containers/container-1/logs") {
			http.NotFound(w, r)
			return
		}
		logsQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/vnd.docker.raw-stream")
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	reader, err := c.ContainerLogsFollow(context.Background(), "container-1", 0, true, "")
	if err != nil {
		t.Fatalf("container logs follow: %v", err)
	}
	_ = reader.Close()

	if logsQuery == "" {
		t.Fatal("expected logs request")
	}
	if strings.Contains(logsQuery, "tail=all") {
		t.Fatalf("follow logs must not request full history, query = %q", logsQuery)
	}
	if !strings.Contains(logsQuery, "tail=0") {
		t.Fatalf("follow logs should request tail=0 by default, query = %q", logsQuery)
	}
}

func TestContainerLogsWithUntilDoesNotFallbackToUnboundedHistory(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1.43/containers/container-1/logs") {
			http.NotFound(w, r)
			return
		}
		queries = append(queries, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/vnd.docker.raw-stream")
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	lines, err := c.ContainerLogs(context.Background(), "container-1", 200, true, "", "2026-07-09T12:00:00Z")
	if err != nil {
		t.Fatalf("container logs: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected no lines, got %#v", lines)
	}
	if len(queries) == 0 {
		t.Fatal("expected bounded window log requests")
	}
	for _, rawQuery := range queries {
		if !strings.Contains(rawQuery, "since=") {
			t.Fatalf("unexpected unbounded logs request without since: %q", rawQuery)
		}
		if !strings.Contains(rawQuery, "until=") {
			t.Fatalf("expected until in logs request: %q", rawQuery)
		}
	}
}

func TestContainerCreateConfigKeepsLegacyRestartPolicyAlias(t *testing.T) {
	var cfg ContainerCreateConfig
	if err := json.Unmarshal([]byte(`{"image":"nginx:latest","restart_policy":"unless-stopped"}`), &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}

	if cfg.RestartPolicyLegacy != "unless-stopped" {
		t.Fatalf("legacy restart policy = %q", cfg.RestartPolicyLegacy)
	}
	if cfg.effectiveRestartPolicy() != "unless-stopped" {
		t.Fatalf("effective restart policy = %q", cfg.effectiveRestartPolicy())
	}
}

func TestApplyNanoCPULimitClearsQuotaPeriod(t *testing.T) {
	resources := container.Resources{
		CPUPeriod: 100000,
		CPUQuota:  200000,
	}

	applyNanoCPULimit(&resources, 500000000)

	if resources.NanoCPUs != 500000000 {
		t.Fatalf("expected NanoCPUs 500000000, got %d", resources.NanoCPUs)
	}
	if resources.CPUPeriod != 0 {
		t.Fatalf("expected CPUPeriod to be cleared, got %d", resources.CPUPeriod)
	}
	if resources.CPUQuota != 0 {
		t.Fatalf("expected CPUQuota to be cleared, got %d", resources.CPUQuota)
	}
}

func TestApplyNanoCPULimitClearsAllCpuLimits(t *testing.T) {
	resources := container.Resources{
		NanoCPUs:  1000000000,
		CPUPeriod: 100000,
		CPUQuota:  100000,
	}

	applyNanoCPULimit(&resources, 0)

	if resources.NanoCPUs != 0 {
		t.Fatalf("expected NanoCPUs to be cleared, got %d", resources.NanoCPUs)
	}
	if resources.CPUPeriod != 0 {
		t.Fatalf("expected CPUPeriod to be cleared, got %d", resources.CPUPeriod)
	}
	if resources.CPUQuota != 0 {
		t.Fatalf("expected CPUQuota to be cleared, got %d", resources.CPUQuota)
	}
}

func TestNetworkingConfigForInspectNetworkPreservesBridgeEndpoint(t *testing.T) {
	insp := &container.InspectResponse{
		NetworkSettings: &container.NetworkSettings{
			Networks: map[string]*network.EndpointSettings{
				"bridge": {NetworkID: "bridge-network", IPAddress: netip.MustParseAddr("172.17.0.2")},
			},
		},
	}

	names := inspectNetworkNames(insp)
	cfg := networkingConfigForInspectNetwork(insp, names)

	if len(names) != 1 || names[0] != "bridge" {
		t.Fatalf("expected bridge network name, got %#v", names)
	}
	if cfg == nil {
		t.Fatal("expected networking config")
	}
	endpoint := cfg.EndpointsConfig["bridge"]
	if endpoint == nil {
		t.Fatalf("expected bridge endpoint in networking config, got %#v", cfg.EndpointsConfig)
	}
	if endpoint.NetworkID != "bridge-network" || endpoint.IPAddress.String() != "172.17.0.2" {
		t.Fatalf("unexpected bridge endpoint: %#v", endpoint)
	}
}

func TestAnnotateImageUsageMatchesByImageID(t *testing.T) {
	images := []imagetypes.Summary{
		{ID: "sha256:busybox", RepoTags: []string{"busybox:latest"}, Containers: -1},
		{ID: "sha256:nginx", RepoTags: []string{"nginx:latest"}, Containers: -1},
	}
	containers := []container.Summary{
		{ImageID: "sha256:busybox", Image: "busybox:latest"},
	}

	result := annotateImageUsage(images, containers)

	if result[0].Containers != 1 {
		t.Fatalf("expected busybox usage count 1, got %d", result[0].Containers)
	}
	if result[1].Containers != 0 {
		t.Fatalf("expected nginx usage count 0, got %d", result[1].Containers)
	}
}

func TestAnnotateImageUsageMatchesByRepoTagWhenImageIDMissing(t *testing.T) {
	images := []imagetypes.Summary{
		{ID: "sha256:busybox", RepoTags: []string{"busybox:latest"}, Containers: -1},
	}
	containers := []container.Summary{
		{Image: "busybox:latest"},
	}

	result := annotateImageUsage(images, containers)

	if result[0].Containers != 1 {
		t.Fatalf("expected busybox usage count 1, got %d", result[0].Containers)
	}
}

func TestContainerTopFallsBackWhenDetailedPsArgsFail(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.String())
		if !strings.HasPrefix(r.URL.Path, "/v1.43/containers/container-1/top") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Has("ps_args") {
			http.Error(w, "ps: unrecognized option: o", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Titles":["PID","COMMAND"],"Processes":[["1","sleep"]]}`))
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	data, err := c.ContainerTop(context.Background(), "container-1")
	if err != nil {
		t.Fatalf("container top: %v", err)
	}

	var top container.TopResponse
	if err := json.Unmarshal(data, &top); err != nil {
		t.Fatalf("unmarshal top response: %v", err)
	}
	if len(top.Processes) != 1 || top.Processes[0][1] != "sleep" {
		t.Fatalf("unexpected top response: %#v", top)
	}
	if len(requests) != 2 {
		t.Fatalf("expected detailed request and fallback request, got %#v", requests)
	}
	if !strings.Contains(requests[0], "ps_args=") {
		t.Fatalf("expected first request to include ps_args, got %q", requests[0])
	}
	if strings.Contains(requests[1], "ps_args=") {
		t.Fatalf("expected fallback request without ps_args, got %q", requests[1])
	}
}

func TestEnsureImageSkipsRegistryPullWhenExactReferenceExists(t *testing.T) {
	inspectCalls := 0
	pullCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
			inspectCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			pullCalls++
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	imageRef := "registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := c.EnsureImage(context.Background(), imageRef, ""); err != nil {
		t.Fatalf("ensure image: %v", err)
	}
	if inspectCalls != 1 {
		t.Fatalf("inspect calls = %d, want 1", inspectCalls)
	}
	if pullCalls != 0 {
		t.Fatalf("pull calls = %d, want 0", pullCalls)
	}
}

func TestEnsureImagePullsWhenExactReferenceIsMissing(t *testing.T) {
	inspectCalls := 0
	pullCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
			inspectCalls++
			http.NotFound(w, r)
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			pullCalls++
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	imageRef := "registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := c.EnsureImage(context.Background(), imageRef, ""); err != nil {
		t.Fatalf("ensure image: %v", err)
	}
	if inspectCalls != 1 {
		t.Fatalf("inspect calls = %d, want 1", inspectCalls)
	}
	if pullCalls != 1 {
		t.Fatalf("pull calls = %d, want 1", pullCalls)
	}
}

func TestEnsureImageDoesNotHideInspectFailures(t *testing.T) {
	pullCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
			http.Error(w, "docker engine unavailable", http.StatusInternalServerError)
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			pullCalls++
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	defer cli.Close()

	c := &Client{cli: cli, logger: slog.Default()}
	imageRef := "registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := c.EnsureImage(context.Background(), imageRef, ""); err == nil {
		t.Fatal("expected inspect failure")
	}
	if pullCalls != 0 {
		t.Fatalf("pull calls = %d, want 0", pullCalls)
	}
}

func TestEnsureImageCommandRequiresImmutableDigest(t *testing.T) {
	for _, imageRef := range []string{
		"registry.example.com/gateway/database-connector:latest",
		"registry.example.com/gateway/database-connector@sha256:short",
	} {
		result := &pb.CommandResult{}
		(&DockerPlugin{}).handleImageCommand(&pb.DockerImageCommand{Action: "ensure", ImageRef: imageRef}, result)
		if result.Success || !strings.Contains(result.Error, "immutable sha256 digest") {
			t.Fatalf("ensure %q result = %#v, want immutable digest rejection", imageRef, result)
		}
	}
}

func TestEnsureLocalImageCommandRequiresFixedDevelopmentImage(t *testing.T) {
	for _, imageRef := range []string{
		"registry.example.com/gateway/database-connector:dev",
		"gateway-database-connector:latest",
		"gateway-db-connector:managed-db-final",
	} {
		result := &pb.CommandResult{}
		(&DockerPlugin{}).handleImageCommand(&pb.DockerImageCommand{Action: "ensure-local", ImageRef: imageRef}, result)
		if result.Success || !strings.Contains(result.Error, "fixed development connector image") {
			t.Fatalf("ensure-local %q result = %#v, want fixed image rejection", imageRef, result)
		}
	}
}
