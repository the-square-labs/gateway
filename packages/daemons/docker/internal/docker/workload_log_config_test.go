package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

func gatewayDefaultLogConfig() container.LogConfig {
	return container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "50m", "max-file": "3"}}
}

func TestApplyDefaultWorkloadLogConfig(t *testing.T) {
	tests := []struct {
		name          string
		current       container.LogConfig
		defaultDriver string
		want          container.LogConfig
	}{
		{"unset on a json-file host", container.LogConfig{}, "json-file", gatewayDefaultLogConfig()},
		{"unset with an unknown host driver", container.LogConfig{}, "", gatewayDefaultLogConfig()},
		{"inspected json-file without options", container.LogConfig{Type: "json-file", Config: map[string]string{}}, "json-file", gatewayDefaultLogConfig()},
		{"unset on a local-driver host", container.LogConfig{}, "local", container.LogConfig{}},
		{"unset on a journald host", container.LogConfig{}, "journald", container.LogConfig{}},
		{"inspected json-file on a local-driver host", container.LogConfig{Type: "json-file"}, "local", container.LogConfig{Type: "json-file"}},
		{"explicit json-file options", container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m"}}, "json-file", container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m"}}},
		{"another driver without options", container.LogConfig{Type: "local"}, "json-file", container.LogConfig{Type: "local"}},
		{"another driver with options", container.LogConfig{Type: "syslog", Config: map[string]string{"syslog-address": "udp://1.2.3.4:514"}}, "json-file", container.LogConfig{Type: "syslog", Config: map[string]string{"syslog-address": "udp://1.2.3.4:514"}}},
		{"none driver", container.LogConfig{Type: "none"}, "json-file", container.LogConfig{Type: "none"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			hostCfg := &container.HostConfig{LogConfig: test.current}
			applyDefaultWorkloadLogConfig(hostCfg, test.defaultDriver)
			if !reflect.DeepEqual(hostCfg.LogConfig, test.want) {
				t.Fatalf("log config = %#v, want %#v", hostCfg.LogConfig, test.want)
			}
		})
	}

	applyDefaultWorkloadLogConfig(nil, "json-file") // must not panic

	first, second := &container.HostConfig{}, &container.HostConfig{}
	applyDefaultWorkloadLogConfig(first, "json-file")
	applyDefaultWorkloadLogConfig(second, "json-file")
	first.LogConfig.Config["max-size"] = "1g"
	if second.LogConfig.Config["max-size"] != "50m" {
		t.Fatal("workloads must not share one default options map")
	}
}

func TestIsGatewayDefaultLogConfig(t *testing.T) {
	accepted := []container.LogConfig{
		gatewayDefaultLogConfig(),
		{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		{Type: "", Config: map[string]string{"max-file": "5"}},
	}
	for _, cfg := range accepted {
		if !isGatewayDefaultLogConfig(cfg) {
			t.Fatalf("rotation-only config %#v was not recognized", cfg)
		}
	}
	rejected := []container.LogConfig{
		{},
		{Type: "json-file"},
		{Type: "json-file", Config: map[string]string{"max-size": "50m", "labels": "team"}},
		{Type: "json-file", Config: map[string]string{"tag": "{{.Name}}"}},
		{Type: "local", Config: map[string]string{"max-size": "50m"}},
		{Type: "splunk", Config: map[string]string{"splunk-token": "secret"}},
	}
	for _, cfg := range rejected {
		if isGatewayDefaultLogConfig(cfg) {
			t.Fatalf("config %#v was treated as the Gateway default", cfg)
		}
	}
}

func TestDetectDefaultLoggingDriver(t *testing.T) {
	t.Setenv("GATEWAY_DOCKER_DAEMON_CONFIG", filepath.Join(t.TempDir(), "missing-daemon.json"))
	newInfoClient := func(t *testing.T, handler http.HandlerFunc) *Client {
		t.Helper()
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cli.Close() })
		return &Client{cli: cli, logger: slog.Default()}
	}

	if driver := (&Client{}).defaultWorkloadLogDriver(); driver != "json-file" {
		t.Fatalf("undetected driver = %q, want json-file", driver)
	}

	infoCalls := 0
	local := newInfoClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/info") {
			http.NotFound(w, r)
			return
		}
		infoCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"LoggingDriver":"local"}`))
	})
	if driver := local.DetectDefaultLoggingDriver(context.Background()); driver != "local" {
		t.Fatalf("detected driver = %q, want local", driver)
	}
	for range 3 {
		if driver := local.defaultWorkloadLogDriver(); driver != "local" {
			t.Fatalf("cached driver = %q, want local", driver)
		}
	}
	if infoCalls != 1 {
		t.Fatalf("Docker info queried %d times, want once", infoCalls)
	}

	failing := newInfoClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)
	})
	if driver := failing.DetectDefaultLoggingDriver(context.Background()); driver != "json-file" {
		t.Fatalf("driver after a failed query = %q, want json-file", driver)
	}
}

func TestDetectDefaultLoggingDriverKeepsHostLogOptions(t *testing.T) {
	jsonFileInfo := func(t *testing.T) *Client {
		t.Helper()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"LoggingDriver":"json-file"}`))
		}))
		t.Cleanup(server.Close)
		cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cli.Close() })
		return &Client{cli: cli, logger: slog.Default()}
	}
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"operator log-opts", `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}`, hostConfiguredLogDefaults},
		{"no log-opts", `{"features":{"buildkit":true}}`, "json-file"},
		{"empty log-opts", `{"log-opts":{}}`, "json-file"},
		{"unreadable config", `{not json`, hostConfiguredLogDefaults},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "daemon.json")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GATEWAY_DOCKER_DAEMON_CONFIG", path)
			c := jsonFileInfo(t)
			if driver := c.DetectDefaultLoggingDriver(context.Background()); driver != tc.want {
				t.Fatalf("driver = %q, want %q", driver, tc.want)
			}
			hostCfg := &container.HostConfig{}
			applyDefaultWorkloadLogConfig(hostCfg, c.defaultWorkloadLogDriver())
			if tc.want == hostConfiguredLogDefaults && (hostCfg.LogConfig.Type != "" || len(hostCfg.LogConfig.Config) != 0) {
				t.Fatalf("host log-opts were overridden: %+v", hostCfg.LogConfig)
			}
			if tc.want == "json-file" && hostCfg.LogConfig.Config["max-size"] != "50m" {
				t.Fatalf("default rotation missing: %+v", hostCfg.LogConfig)
			}
		})
	}
}

// createCapturingClient answers container creates and records their host
// configuration; every other request 404s (a missing container on inspect).
func createCapturingClient(t *testing.T) (*Client, func() []*container.HostConfig) {
	t.Helper()
	var mu sync.Mutex
	var hostConfigs []*container.HostConfig
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/containers/create") {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var request container.CreateRequest
		if err := json.Unmarshal(body, &request); err != nil {
			t.Errorf("decode create request: %v", err)
		}
		mu.Lock()
		hostConfigs = append(hostConfigs, request.HostConfig)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"Id":"created-1","Warnings":[]}`))
	}))
	t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return &Client{cli: cli, logger: slog.Default()}, func() []*container.HostConfig {
		mu.Lock()
		defer mu.Unlock()
		return append([]*container.HostConfig(nil), hostConfigs...)
	}
}

func setDetectedLogDriver(c *Client, driver string) {
	c.defaultLogDriver.Store(&driver)
}

func TestCreateContainerAppliesDefaultLogRotation(t *testing.T) {
	c, created := createCapturingClient(t)
	if _, _, err := c.CreateContainer(context.Background(), `{"name":"app","image":"busybox"}`); err != nil {
		t.Fatal(err)
	}
	setDetectedLogDriver(c, "journald")
	if _, _, err := c.CreateContainer(context.Background(), `{"name":"app-2","image":"busybox"}`); err != nil {
		t.Fatal(err)
	}
	hostConfigs := created()
	if len(hostConfigs) != 2 {
		t.Fatalf("creates = %d, want 2", len(hostConfigs))
	}
	if !reflect.DeepEqual(hostConfigs[0].LogConfig, gatewayDefaultLogConfig()) {
		t.Fatalf("json-file host log config = %#v, want the Gateway default", hostConfigs[0].LogConfig)
	}
	if hostConfigs[1].LogConfig.Type != "" || len(hostConfigs[1].LogConfig.Config) != 0 {
		t.Fatalf("journald host log config = %#v, want empty so the host policy wins", hostConfigs[1].LogConfig)
	}
}

func TestUpdateContainerAddsDefaultLogRotationToUnconfiguredWorkload(t *testing.T) {
	fake := &recreateFakeDocker{}
	c := newRecreateTestClient(t, fake)
	if err := c.UpdateContainer(context.Background(), "old-container", "", map[string]string{"FOO": "bar"}, nil, "", ""); err != nil {
		t.Fatalf("update container: %v", err)
	}
	if len(fake.creates) != 1 || fake.creates[0].HostConfig == nil {
		t.Fatalf("creates = %d, want 1 with a host config", len(fake.creates))
	}
	if got := fake.creates[0].HostConfig.LogConfig; !reflect.DeepEqual(got, gatewayDefaultLogConfig()) {
		t.Fatalf("recreated log config = %#v, want the Gateway default", got)
	}
}

func TestCreateContainerStoppedKeepsExplicitLogConfig(t *testing.T) {
	manifest := func(logConfig container.LogConfig) dockerMigrationManifest {
		return dockerMigrationManifest{
			SchemaVersion: 1,
			Name:          "migrated",
			ImageID:       "sha256:" + strings.Repeat("a", 64),
			Config:        &container.Config{Image: "app:1"},
			HostConfig:    &container.HostConfig{LogConfig: logConfig},
		}
	}
	c, created := createCapturingClient(t)
	for index, logConfig := range []container.LogConfig{
		{Type: "json-file"},
		{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "2"}},
		{Type: "local"},
	} {
		if _, err := c.CreateContainerStopped(context.Background(), createStoppedContainerRequest{
			MigrationID: "migration-1", Manifest: manifest(logConfig),
		}); err != nil {
			t.Fatalf("create %d: %v", index, err)
		}
	}
	hostConfigs := created()
	if len(hostConfigs) != 3 {
		t.Fatalf("creates = %d, want 3", len(hostConfigs))
	}
	if !reflect.DeepEqual(hostConfigs[0].LogConfig, gatewayDefaultLogConfig()) {
		t.Fatalf("unconfigured migrated workload log config = %#v, want the Gateway default", hostConfigs[0].LogConfig)
	}
	if got := hostConfigs[1].LogConfig; got.Type != "json-file" || !reflect.DeepEqual(got.Config, map[string]string{"max-size": "10m", "max-file": "2"}) {
		t.Fatalf("explicit rotation was changed: %#v", got)
	}
	if got := hostConfigs[2].LogConfig; got.Type != "local" || len(got.Config) != 0 {
		t.Fatalf("another driver was changed: %#v", got)
	}
}

func TestValidateGwcaExportSupportAllowsGatewayDefaultLogConfig(t *testing.T) {
	host := &container.HostConfig{Runtime: "runc", ShmSize: 64 * 1024 * 1024, LogConfig: gatewayDefaultLogConfig()}
	if err := validateGwcaExportSupport(&container.Config{}, host, nil); err != nil {
		t.Fatalf("Gateway default log rotation made the container unexportable: %v", err)
	}
	for _, logConfig := range []container.LogConfig{
		{Type: "json-file", Config: map[string]string{"max-size": "50m", "tag": "{{.Name}}"}},
		{Type: "syslog"},
		{Type: "splunk", Config: map[string]string{"splunk-token": "secret"}},
	} {
		host := &container.HostConfig{Runtime: "runc", ShmSize: 64 * 1024 * 1024, LogConfig: logConfig}
		err := validateGwcaExportSupport(&container.Config{}, host, nil)
		if err == nil || !strings.Contains(err.Error(), "custom log driver configuration") {
			t.Fatalf("log config %#v: err = %v, want custom log driver rejection", logConfig, err)
		}
	}
}

func TestCaptureMigrationManifestKeepsGatewayDefaultLogConfig(t *testing.T) {
	inspect := func(logConfig string) string {
		return `{
  "Id": "source-container",
  "Name": "/app",
  "Image": "sha256:` + strings.Repeat("b", 64) + `",
  "Config": {"Image": "app:1", "Env": ["A=1"], "Labels": {}},
  "HostConfig": {"NetworkMode": "bridge", "LogConfig": ` + logConfig + `},
  "Mounts": [],
  "NetworkSettings": {"Networks": {}}
}`
	}
	capture := func(t *testing.T, logConfig string) dockerMigrationManifest {
		t.Helper()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/containers/source-container/json") {
				t.Errorf("unexpected docker request %s %s", r.Method, r.URL.Path)
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(inspect(logConfig)))
		}))
		t.Cleanup(server.Close)
		cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cli.Close() })
		manifest, err := (&Client{cli: cli, logger: slog.Default()}).CaptureMigrationManifest(context.Background(), "source-container")
		if err != nil {
			t.Fatalf("capture manifest: %v", err)
		}
		return manifest
	}

	defaultManifest := capture(t, `{"Type":"json-file","Config":{"max-size":"50m","max-file":"3"}}`)
	for _, blocker := range defaultManifest.Blockers {
		if strings.Contains(blocker, "log driver") {
			t.Fatalf("Gateway default log rotation blocked the migration: %v", defaultManifest.Blockers)
		}
	}
	if got := defaultManifest.HostConfig.LogConfig; !reflect.DeepEqual(got, gatewayDefaultLogConfig()) {
		t.Fatalf("migrated log config = %#v, want the Gateway default preserved", got)
	}

	secretManifest := capture(t, `{"Type":"splunk","Config":{"splunk-token":"secret","splunk-url":"https://splunk.example"}}`)
	blocked := false
	for _, blocker := range secretManifest.Blockers {
		if strings.Contains(blocker, "log driver") {
			blocked = true
		}
	}
	if !blocked {
		t.Fatalf("custom log driver options were not blocked: %v", secretManifest.Blockers)
	}
	for key, value := range secretManifest.HostConfig.LogConfig.Config {
		if value != "" {
			t.Fatalf("custom log driver option %q leaked its value into the manifest", key)
		}
	}
}
