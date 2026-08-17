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
	"github.com/wiolett-industries/gateway/daemon-shared/gpu"
)

func TestDockerPortMappingsPreservesPublishAddress(t *testing.T) {
	exposed, bindings, err := dockerPortMappings([]containerPortMapping{
		{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"},
		{HostIP: "192.168.1.20", HostPort: 5353, ContainerPort: 53, Protocol: "udp"},
	})
	if err != nil {
		t.Fatalf("unexpected mapping error: %v", err)
	}
	if len(exposed) != 2 || len(bindings) != 2 {
		t.Fatalf("expected two exposed ports and bindings, got %d and %d", len(exposed), len(bindings))
	}
	httpPort, _ := network.ParsePort("80/tcp")
	if got := bindings[httpPort][0].HostIP.String(); got != "127.0.0.1" {
		t.Fatalf("expected loopback binding, got %q", got)
	}
	dnsPort, _ := network.ParsePort("53/udp")
	if got := bindings[dnsPort][0].HostIP.String(); got != "192.168.1.20" {
		t.Fatalf("expected interface binding, got %q", got)
	}
}

func TestDockerPortMappingsDefaultsToAllInterfaces(t *testing.T) {
	_, bindings, err := dockerPortMappings([]containerPortMapping{{HostPort: 8080, ContainerPort: 80}})
	if err != nil {
		t.Fatalf("unexpected mapping error: %v", err)
	}
	httpPort, _ := network.ParsePort("80/tcp")
	if got := bindings[httpPort][0].HostIP.String(); got != "0.0.0.0" {
		t.Fatalf("expected all-interface binding, got %q", got)
	}
}

func TestApplyUserWorkloadBaseline(t *testing.T) {
	host := &container.HostConfig{Privileged: true, CapAdd: []string{"SYS_ADMIN"}}
	applyUserWorkloadBaseline(host)
	if host.Privileged || len(host.CapAdd) != 0 {
		t.Fatalf("unsafe privilege settings survived baseline: privileged=%v capAdd=%v", host.Privileged, host.CapAdd)
	}
	if len(host.SecurityOpt) != 1 || host.SecurityOpt[0] != "no-new-privileges:true" {
		t.Fatalf("security options = %v", host.SecurityOpt)
	}
}

func TestSecureRuntimeProfileFailsClosedAndRejectsGPU(t *testing.T) {
	client := &Client{}
	if err := client.applyRuntimeProfile(&container.HostConfig{}, "secure", nil); err == nil {
		t.Fatal("expected Secure Runtime to fail while runsc health is unknown")
	}
	client.runscHealthy.Store(true)
	host := &container.HostConfig{}
	if err := client.applyRuntimeProfile(host, "secure", nil); err != nil {
		t.Fatalf("apply healthy Secure Runtime: %v", err)
	}
	if host.Runtime != "runsc" {
		t.Fatalf("runtime = %q", host.Runtime)
	}
	if err := client.applyRuntimeProfile(
		&container.HostConfig{},
		"secure",
		&GPUConfig{DeviceIDs: []string{"nvidia:GPU-1"}},
	); err == nil {
		t.Fatal("expected Secure Runtime to reject GPU attachment")
	}
}

func TestCreateManagedVolumeRejectsExistingVolumeWithoutCreating(t *testing.T) {
	createCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes/data"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Name":"data","Driver":"local","Labels":{}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create"):
			createCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Name":"data","Driver":"local","Labels":{}}`))
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
	if err := c.CreateManagedVolume(context.Background(), "data"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected existing-volume conflict, got %v", err)
	}
	if createCalls != 0 {
		t.Fatalf("volume create calls = %d, want 0", createCalls)
	}
}

func TestCreateManagedVolumeRejectsConcurrentUnmanagedResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes/data"):
			http.NotFound(w, r)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Name":"data","Driver":"local","Labels":{}}`))
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
	if err := c.CreateManagedVolume(context.Background(), "data"); err == nil || !strings.Contains(err.Error(), "appeared concurrently") {
		t.Fatalf("expected concurrent-volume conflict, got %v", err)
	}
}

func TestCreateManagedVolumeCreatesLabeledVolume(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/volumes/data"):
			http.NotFound(w, r)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Name":"data","Driver":"local","Labels":{"com.wiolett.gateway.managed-volume":"true","com.wiolett.gateway.managed-volume-origin":"created"}}`))
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
	if err := c.CreateManagedVolume(context.Background(), "data"); err != nil {
		t.Fatalf("create managed volume: %v", err)
	}
}

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

func TestCreateContainerRejectsUnknownConfigFields(t *testing.T) {
	client := &Client{}
	_, _, err := client.CreateContainer(context.Background(), `{"image":"nginx:alpine","volumes":[]}`)
	if err == nil || !strings.Contains(err.Error(), `unknown field "volumes"`) {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestManagedDatabaseConnectorBindIsNarrowlyAllowlisted(t *testing.T) {
	client := &Client{databaseTunnelDirectory: "/var/lib/docker-daemon/database-tunnel"}
	valid := ContainerCreateConfig{
		Name:             "gateway-db-connector-binding-1",
		InternalWorkload: "managed-database-connector",
		Labels: map[string]string{
			"wiolett.gateway.managed-database.connector": "true",
		},
		Binds: []string{"/var/lib/docker-daemon/database-tunnel:/run/gateway-db:ro"},
	}
	if !client.isManagedDatabaseConnector(valid) {
		t.Fatal("expected the daemon-owned database tunnel bind to be allowed")
	}

	tests := map[string]ContainerCreateConfig{
		"wrong source": func() ContainerCreateConfig {
			cfg := valid
			cfg.Binds = []string{"/tmp/database-tunnel:/run/gateway-db:ro"}
			return cfg
		}(),
		"writable bind": func() ContainerCreateConfig {
			cfg := valid
			cfg.Binds = []string{"/var/lib/docker-daemon/database-tunnel:/run/gateway-db:rw"}
			return cfg
		}(),
		"extra bind": func() ContainerCreateConfig {
			cfg := valid
			cfg.Binds = append(append([]string(nil), valid.Binds...), "/tmp:/tmp:ro")
			return cfg
		}(),
		"missing marker": func() ContainerCreateConfig {
			cfg := valid
			cfg.InternalWorkload = ""
			return cfg
		}(),
	}
	for name, cfg := range tests {
		t.Run(name, func(t *testing.T) {
			if client.isManagedDatabaseConnector(cfg) {
				t.Fatal("unexpectedly allowed connector bind")
			}
		})
	}
}

func TestImportedArchiveUsesImageIDForEnvOnlyRecreateAndLabelForTagUpdate(t *testing.T) {
	imageID := "sha256:" + repeatHex("a")
	insp := &container.InspectResponse{
		Image: imageID,
		Config: &container.Config{
			Image: imageID,
			Labels: map[string]string{
				archiveImageReferenceLabel: "registry.example/team/app:stable",
			},
		},
	}
	if got := containerRecreateImageReference(insp); got != imageID {
		t.Fatalf("env-only recreate image = %q, want image ID %q", got, imageID)
	}
	if got := containerTagUpdateImageReference(insp); got != "registry.example/team/app:stable" {
		t.Fatalf("tag update source = %q", got)
	}
}

func TestApplyGPUSelectionReplacesOnlyManagedGPUEntries(t *testing.T) {
	hostCfg := &container.HostConfig{
		Runtime: "nvidia",
		Resources: container.Resources{
			Devices: []container.DeviceMapping{
				{PathOnHost: "/dev/random", PathInContainer: "/dev/random", CgroupPermissions: "r"},
				{PathOnHost: "/dev/kfd", PathInContainer: "/dev/kfd", CgroupPermissions: "rwm"},
				{PathOnHost: "/dev/dri/renderD128", PathInContainer: "/dev/dri/renderD128", CgroupPermissions: "rwm"},
			},
			DeviceRequests: []container.DeviceRequest{
				{Driver: "vendor-other", DeviceIDs: []string{"keep"}},
				{Driver: "nvidia", Count: 0, DeviceIDs: []string{"old-gpu"}, Capabilities: [][]string{{"gpu"}}},
				{Driver: "", Count: 0, DeviceIDs: []string{"old-default"}, Capabilities: [][]string{{"gpu"}}},
			},
		},
		GroupAdd: []string{"44"},
	}

	applyGPUSelection(hostCfg, []gpu.Device{
		{Vendor: gpu.VendorNVIDIA, RuntimeID: "GPU-new"},
		{Vendor: gpu.VendorAMD, DevicePaths: []string{"/dev/kfd", "/dev/dri/renderD130"}, GroupIDs: []string{"105"}},
		{Vendor: gpu.VendorAMD, DevicePaths: []string{"/dev/kfd", "/dev/dri/renderD131"}, GroupIDs: []string{"105"}},
	}, nil)

	if hostCfg.Runtime != "" {
		t.Fatalf("legacy NVIDIA runtime was not cleared: %q", hostCfg.Runtime)
	}
	if len(hostCfg.DeviceRequests) != 2 || hostCfg.DeviceRequests[0].Driver != "vendor-other" {
		t.Fatalf("non-GPU device request was not preserved: %#v", hostCfg.DeviceRequests)
	}
	request := hostCfg.DeviceRequests[1]
	if request.Driver != "nvidia" || len(request.DeviceIDs) != 1 || request.DeviceIDs[0] != "GPU-new" {
		t.Fatalf("unexpected NVIDIA request: %#v", request)
	}
	paths := make(map[string]bool)
	for _, mapping := range hostCfg.Devices {
		paths[mapping.PathOnHost] = true
	}
	for _, expected := range []string{"/dev/random", "/dev/kfd", "/dev/dri/renderD130", "/dev/dri/renderD131"} {
		if !paths[expected] {
			t.Fatalf("expected device path %q, got %#v", expected, hostCfg.Devices)
		}
	}
	if paths["/dev/dri/renderD128"] {
		t.Fatalf("stale managed GPU mapping was retained: %#v", hostCfg.Devices)
	}
	if len(hostCfg.GroupAdd) != 2 || hostCfg.GroupAdd[0] != "44" || hostCfg.GroupAdd[1] != "105" {
		t.Fatalf("unexpected GPU group list: %#v", hostCfg.GroupAdd)
	}
}

func TestApplyGPUSelectionDetachesDefaultNVIDIARequest(t *testing.T) {
	hostCfg := &container.HostConfig{
		Resources: container.Resources{
			DeviceRequests: []container.DeviceRequest{
				{
					Driver:       "",
					Count:        0,
					DeviceIDs:    []string{"GPU-old"},
					Capabilities: [][]string{{"gpu"}},
				},
			},
		},
	}

	applyGPUSelection(hostCfg, nil, nil)

	if len(hostCfg.DeviceRequests) != 0 {
		t.Fatalf("legacy default NVIDIA request was retained: %#v", hostCfg.DeviceRequests)
	}
}

func TestApplyGPUSelectionPreservesCustomNVIDIARequest(t *testing.T) {
	hostCfg := &container.HostConfig{
		Resources: container.Resources{
			DeviceRequests: []container.DeviceRequest{
				{
					Driver:       "nvidia",
					Count:        0,
					DeviceIDs:    []string{"GPU-custom"},
					Capabilities: [][]string{{"gpu", "compute"}},
					Options:      map[string]string{"capabilities": "compute,utility"},
				},
			},
		},
	}

	applyGPUSelection(hostCfg, nil, nil)

	if len(hostCfg.DeviceRequests) != 1 || hostCfg.DeviceRequests[0].Driver != "nvidia" {
		t.Fatalf("custom NVIDIA request was removed: %#v", hostCfg.DeviceRequests)
	}
}

func TestApplyGPUSelectionReplacesManagedGPUGroupIDs(t *testing.T) {
	containerCfg := &container.Config{Labels: map[string]string{
		gatewayGPUGroupIDsLabel:        "105",
		gatewayGPUGroupIDsVersionLabel: gatewayGPUGroupIDsVersion,
	}}
	hostCfg := &container.HostConfig{Resources: container.Resources{}, GroupAdd: []string{"44", "105"}}

	nextManaged := applyGPUSelection(
		hostCfg,
		[]gpu.Device{{Vendor: gpu.VendorIntel, DevicePaths: []string{"/dev/dri/renderD130"}, GroupIDs: []string{"106"}}},
		managedGPUGroupIDs(containerCfg),
	)
	setManagedGPUGroupIDs(containerCfg, nextManaged)

	if got, want := strings.Join(hostCfg.GroupAdd, ","), "44,106"; got != want {
		t.Fatalf("replaced GPU group IDs = %q, want %q", got, want)
	}
	if got := containerCfg.Labels[gatewayGPUGroupIDsLabel]; got != "106" {
		t.Fatalf("managed GPU group label = %q, want %q", got, "106")
	}

	nextManaged = applyGPUSelection(hostCfg, nil, managedGPUGroupIDs(containerCfg))
	setManagedGPUGroupIDs(containerCfg, nextManaged)

	if got, want := strings.Join(hostCfg.GroupAdd, ","), "44"; got != want {
		t.Fatalf("detached GPU group IDs = %q, want %q", got, want)
	}
	if _, exists := containerCfg.Labels[gatewayGPUGroupIDsLabel]; exists {
		t.Fatalf("managed GPU group label was retained: %#v", containerCfg.Labels)
	}
}

func TestGPUDetachDoesNotInferOwnershipFromLegacyMappings(t *testing.T) {
	containerCfg := &container.Config{}
	hostCfg := &container.HostConfig{Resources: container.Resources{
		Devices: []container.DeviceMapping{
			{PathOnHost: "/dev/kfd", PathInContainer: "/dev/kfd", CgroupPermissions: "rwm"},
			{PathOnHost: "/dev/dri/renderD128", PathInContainer: "/dev/dri/renderD128", CgroupPermissions: "rwm"},
		},
	}, GroupAdd: []string{"44", "105"}}
	if previous := managedGPUGroupIDs(containerCfg); len(previous) != 0 {
		t.Fatalf("legacy GPU mapping was treated as Gateway-owned: %#v", previous)
	}

	applyGPUSelection(hostCfg, nil, managedGPUGroupIDs(containerCfg))
	if got, want := strings.Join(hostCfg.GroupAdd, ","), "44,105"; got != want {
		t.Fatalf("legacy GPU group IDs were removed without provenance: %q, want %q", got, want)
	}
}

func TestGatewayGPUGroupLabelSurvivesLabelReplacementAndDetach(t *testing.T) {
	containerCfg := &container.Config{Labels: map[string]string{
		gatewayGPUGroupIDsLabel:        "105",
		gatewayGPUGroupIDsVersionLabel: gatewayGPUGroupIDsVersion,
		"user.label":                   "before",
	}}
	replacementLabels := map[string]string{
		gatewayGPUGroupIDsLabel:        "999",
		gatewayGPUGroupIDsVersionLabel: "unexpected",
		"user.label":                   "after",
	}
	preserveGatewayManagedContainerLabels(containerCfg.Labels, replacementLabels)
	containerCfg.Labels = replacementLabels

	if got := containerCfg.Labels[gatewayGPUGroupIDsLabel]; got != "105" {
		t.Fatalf("replacement overwrote managed GPU group label: %q", got)
	}
	if got := containerCfg.Labels[gatewayGPUGroupIDsVersionLabel]; got != gatewayGPUGroupIDsVersion {
		t.Fatalf("replacement overwrote managed GPU group label version: %q", got)
	}

	hostCfg := &container.HostConfig{Resources: container.Resources{
		Devices: []container.DeviceMapping{
			{PathOnHost: "/dev/kfd", PathInContainer: "/dev/kfd", CgroupPermissions: "rwm"},
			{PathOnHost: "/dev/dri/renderD128", PathInContainer: "/dev/dri/renderD128", CgroupPermissions: "rwm"},
		},
	}, GroupAdd: []string{"44", "105"}}
	previous := managedGPUGroupIDs(containerCfg)
	if got, want := strings.Join(previous, ","), "105"; got != want {
		t.Fatalf("managed GPU group IDs = %q, want %q", got, want)
	}
	nextManaged := applyGPUSelection(hostCfg, nil, previous)
	setManagedGPUGroupIDs(containerCfg, nextManaged)

	if got, want := strings.Join(hostCfg.GroupAdd, ","), "44"; got != want {
		t.Fatalf("detached GPU group IDs = %q, want %q", got, want)
	}
	if _, exists := containerCfg.Labels[gatewayGPUGroupIDsLabel]; exists {
		t.Fatalf("managed GPU group label was retained: %#v", containerCfg.Labels)
	}
}

func TestGatewayGPUGroupProvenanceCannotBeIntroducedByLabelReplacement(t *testing.T) {
	existingLabels := map[string]string{"user.label": "before"}
	replacementLabels := map[string]string{
		gatewayGPUGroupIDsLabel:        "105",
		gatewayGPUGroupIDsVersionLabel: gatewayGPUGroupIDsVersion,
		"user.label":                   "after",
	}

	preserveGatewayManagedContainerLabels(existingLabels, replacementLabels)

	for _, label := range []string{gatewayGPUGroupIDsLabel, gatewayGPUGroupIDsVersionLabel} {
		if _, exists := replacementLabels[label]; exists {
			t.Fatalf("replacement introduced daemon-owned GPU provenance %q: %#v", label, replacementLabels)
		}
	}
}

func TestGPUDetachKeepsGroupThatPredatesGatewayAttachment(t *testing.T) {
	containerCfg := &container.Config{}
	hostCfg := &container.HostConfig{Resources: container.Resources{}, GroupAdd: []string{"44", "105"}}
	devices := []gpu.Device{{
		Vendor:      gpu.VendorAMD,
		DevicePaths: []string{"/dev/kfd", "/dev/dri/renderD128"},
		GroupIDs:    []string{"105"},
	}}

	nextManaged := applyGPUSelection(hostCfg, devices, managedGPUGroupIDs(containerCfg))
	setManagedGPUGroupIDs(containerCfg, nextManaged)
	if len(nextManaged) != 0 || containerCfg.Labels[gatewayGPUGroupIDsLabel] != "" {
		t.Fatalf("pre-existing GPU group was recorded as Gateway-managed: managed=%#v labels=%#v", nextManaged, containerCfg.Labels)
	}

	nextManaged = applyGPUSelection(hostCfg, nil, managedGPUGroupIDs(containerCfg))
	setManagedGPUGroupIDs(containerCfg, nextManaged)
	if got, want := strings.Join(hostCfg.GroupAdd, ","), "44,105"; got != want {
		t.Fatalf("detach removed group that predated GPU attachment: %q, want %q", got, want)
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
