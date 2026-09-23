package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"
)

const recreateTestInspect = `{
  "Id": "old-container",
  "Name": "/postgres",
  "Image": "sha256:oldimage",
  "State": {"Running": false},
  "Config": {
    "Image": "postgres:15",
    "Env": ["PATH=/usr/local/bin", "PG_MAJOR=15", "POSTGRES_PASSWORD=secret"],
    "Cmd": ["postgres"],
    "Entrypoint": ["docker-entrypoint.sh"],
    "WorkingDir": "/",
    "Volumes": {"/var/lib/postgresql/data": {}, "/cache": {}},
    "Labels": {"org.opencontainers.image.version": "15", "team": "db"}
  },
  "HostConfig": {
    "Binds": ["named-config:/etc/app:ro", "/srv/logs:/logs"],
    "Tmpfs": {"/run": ""}
  },
  "Mounts": [
    {"Type": "volume", "Name": "0123abcd", "Destination": "/var/lib/postgresql/data", "RW": true},
    {"Type": "volume", "Name": "4567ef01", "Destination": "/cache", "RW": false},
    {"Type": "volume", "Name": "named-config", "Destination": "/etc/app", "RW": false},
    {"Type": "bind", "Source": "/srv/logs", "Destination": "/logs", "RW": true}
  ],
  "NetworkSettings": {"Networks": {}}
}`

type recreateFakeDocker struct {
	mu            sync.Mutex
	creates       []container.CreateRequest
	failCreates   int
	onCreate      func()
	removed       []string
	images        map[string]string
	imageInspects []string
}

func (f *recreateFakeDocker) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/v1.43")
		switch {
		case r.Method == http.MethodGet && path == "/containers/old-container/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(recreateTestInspect))
		case r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
			f.removed = append(f.removed, strings.TrimPrefix(path, "/containers/"))
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && path == "/containers/create":
			body, _ := io.ReadAll(r.Body)
			var request container.CreateRequest
			if err := json.Unmarshal(body, &request); err != nil {
				t.Errorf("decode create request: %v", err)
			}
			f.creates = append(f.creates, request)
			if f.onCreate != nil {
				f.onCreate()
			}
			if len(f.creates) <= f.failCreates {
				http.Error(w, `{"message":"create failed"}`, http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Id":"new-container"}`))
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
			ref := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
			f.imageInspects = append(f.imageInspects, ref)
			body, ok := f.images[ref]
			if !ok {
				http.Error(w, `{"message":"no such image"}`, http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		default:
			t.Errorf("unexpected docker request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}
}

func newRecreateTestClient(t *testing.T, fake *recreateFakeDocker) *Client {
	t.Helper()
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create docker client: %v", err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return &Client{cli: cli, logger: slog.Default()}
}

func mountTargets(mounts []mount.Mount) map[string]mount.Mount {
	byTarget := make(map[string]mount.Mount, len(mounts))
	for _, entry := range mounts {
		byTarget[entry.Target] = entry
	}
	return byTarget
}

func assertAnonymousVolumesPreserved(t *testing.T, request container.CreateRequest) {
	t.Helper()
	if request.HostConfig == nil {
		t.Fatal("create request has no host config")
	}
	byTarget := mountTargets(request.HostConfig.Mounts)
	data, ok := byTarget["/var/lib/postgresql/data"]
	if !ok || data.Type != mount.TypeVolume || data.Source != "0123abcd" || data.ReadOnly {
		t.Fatalf("anonymous data volume not re-attached read-write by name: %#v", request.HostConfig.Mounts)
	}
	cache, ok := byTarget["/cache"]
	if !ok || cache.Source != "4567ef01" || !cache.ReadOnly {
		t.Fatalf("read-only anonymous volume not re-attached read-only: %#v", request.HostConfig.Mounts)
	}
	if _, duplicated := byTarget["/etc/app"]; duplicated {
		t.Fatalf("named volume already covered by Binds was duplicated: %#v", request.HostConfig.Mounts)
	}
	if _, duplicated := byTarget["/logs"]; duplicated {
		t.Fatalf("bind mount was duplicated: %#v", request.HostConfig.Mounts)
	}
}

func TestPreservedVolumeMountsOnlyReattachesAnonymousVolumes(t *testing.T) {
	var insp container.InspectResponse
	if err := json.Unmarshal([]byte(recreateTestInspect), &insp); err != nil {
		t.Fatalf("decode inspect: %v", err)
	}
	insp.Mounts = append(insp.Mounts, container.MountPoint{Type: mount.TypeVolume, Name: "tmp-vol", Destination: "/run", RW: true})

	preserved := preservedVolumeMounts(&insp)
	if len(preserved) != 2 {
		t.Fatalf("preserved mounts = %#v, want the two anonymous volumes", preserved)
	}
	assertAnonymousVolumesPreserved(t, container.CreateRequest{HostConfig: &container.HostConfig{Mounts: preserved}})
}

func TestUpdateContainerReattachesAnonymousVolumes(t *testing.T) {
	fake := &recreateFakeDocker{}
	c := newRecreateTestClient(t, fake)

	if err := c.UpdateContainer(context.Background(), "old-container", "", map[string]string{"FOO": "bar"}, nil, "", ""); err != nil {
		t.Fatalf("update container: %v", err)
	}
	if len(fake.creates) != 1 {
		t.Fatalf("creates = %d, want 1", len(fake.creates))
	}
	assertAnonymousVolumesPreserved(t, fake.creates[0])
	if !slices.Contains(fake.creates[0].Env, "FOO=bar") || !slices.Contains(fake.creates[0].Env, "PG_MAJOR=15") {
		t.Fatalf("env-only update changed inherited env: %#v", fake.creates[0].Env)
	}
}

func TestRecreateWithConfigMountOverrideKeepsAnonymousVolumes(t *testing.T) {
	fake := &recreateFakeDocker{}
	c := newRecreateTestClient(t, fake)

	config := `{"mounts":[{"name":"named-config","containerPath":"/etc/app","readOnly":true}]}`
	if err := c.RecreateWithConfig(context.Background(), "old-container", config); err != nil {
		t.Fatalf("recreate container: %v", err)
	}
	if len(fake.creates) != 1 {
		t.Fatalf("creates = %d, want 1", len(fake.creates))
	}
	assertAnonymousVolumesPreserved(t, fake.creates[0])
	if got := fake.creates[0].HostConfig.Binds; !slices.Equal(got, []string{"named-config:/etc/app:ro"}) {
		t.Fatalf("binds = %#v", got)
	}
}

func TestRecreateRollbackSurvivesCancelledTaskContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &recreateFakeDocker{failCreates: 1}
	fake.onCreate = func() {
		// The task is killed while Docker is creating the replacement.
		cancel()
	}
	c := newRecreateTestClient(t, fake)

	err := c.UpdateContainer(ctx, "old-container", "", map[string]string{"FOO": "bar"}, nil, "", "")
	if err == nil || !strings.Contains(err.Error(), "original container restored") {
		t.Fatalf("update error = %v, want restored rollback", err)
	}
	if len(fake.creates) != 2 {
		t.Fatalf("creates = %d, want failed create plus rollback create", len(fake.creates))
	}
	rollback := fake.creates[1]
	if slices.Contains(rollback.Env, "FOO=bar") {
		t.Fatalf("rollback reused the failed configuration: %#v", rollback.Env)
	}
	assertAnonymousVolumesPreserved(t, rollback)
}

func TestRecreateWithNewImageDropsPreviousImageDefaults(t *testing.T) {
	fake := &recreateFakeDocker{images: map[string]string{
		"sha256:oldimage": `{"Id":"sha256:oldimage","Config":{
			"Env":["PATH=/usr/local/bin","PG_MAJOR=15"],
			"Cmd":["postgres"],
			"Entrypoint":["docker-entrypoint.sh"],
			"WorkingDir":"/",
			"Labels":{"org.opencontainers.image.version":"15"}
		}}`,
		"postgres:16": `{"Id":"sha256:newimage","Config":{"Env":["PATH=/usr/local/bin","PG_MAJOR=16"],"Cmd":["postgres"]}}`,
	}}
	c := newRecreateTestClient(t, fake)

	config := `{"image":"postgres:16","workingDir":"/srv","env":{"PG_MAJOR":"15","POSTGRES_PASSWORD":"secret","EXTRA":"1"}}`
	if err := c.RecreateWithConfig(context.Background(), "old-container", config); err != nil {
		t.Fatalf("recreate container: %v", err)
	}
	if len(fake.creates) != 1 {
		t.Fatalf("creates = %d, want 1", len(fake.creates))
	}
	created := fake.creates[0]
	if created.Image != "postgres:16" {
		t.Fatalf("image = %q", created.Image)
	}
	for _, entry := range created.Env {
		if strings.HasPrefix(entry, "PG_MAJOR=") || strings.HasPrefix(entry, "PATH=") {
			t.Fatalf("previous image default %q pinned on the new image: %#v", entry, created.Env)
		}
	}
	if !slices.Contains(created.Env, "POSTGRES_PASSWORD=secret") || !slices.Contains(created.Env, "EXTRA=1") {
		t.Fatalf("explicit env lost: %#v", created.Env)
	}
	if created.Cmd != nil || created.Entrypoint != nil {
		t.Fatalf("inherited cmd/entrypoint kept: cmd=%#v entrypoint=%#v", created.Cmd, created.Entrypoint)
	}
	if created.WorkingDir != "/srv" {
		t.Fatalf("explicit working dir = %q, want /srv", created.WorkingDir)
	}
	if _, stale := created.Labels["org.opencontainers.image.version"]; stale || created.Labels["team"] != "db" {
		t.Fatalf("labels = %#v", created.Labels)
	}
	assertAnonymousVolumesPreserved(t, created)
}

func TestRecreateWithSameImageKeepsInheritedConfig(t *testing.T) {
	fake := &recreateFakeDocker{images: map[string]string{
		"postgres:15": `{"Id":"sha256:oldimage","Config":{"Env":["PG_MAJOR=15"],"Cmd":["postgres"]}}`,
	}}
	c := newRecreateTestClient(t, fake)

	if err := c.RecreateWithConfig(context.Background(), "old-container", `{"image":"postgres:15"}`); err != nil {
		t.Fatalf("recreate container: %v", err)
	}
	created := fake.creates[0]
	if !slices.Contains(created.Env, "PG_MAJOR=15") || !slices.Equal(created.Cmd, []string{"postgres"}) {
		t.Fatalf("unchanged image dropped config: env=%#v cmd=%#v", created.Env, created.Cmd)
	}
}

func TestDropInheritedImageDefaultsKeepsExplicitValues(t *testing.T) {
	config := &container.Config{
		Env:        []string{"A=default", "B=custom", "C=default"},
		Cmd:        []string{"serve"},
		Entrypoint: []string{"/custom-entrypoint"},
		User:       "1000",
		Healthcheck: &container.HealthConfig{
			Test: []string{"CMD", "true"},
		},
	}
	previous := &image.InspectResponse{Config: nil}
	if got := dropInheritedImageDefaults(config, previous, map[string]string{"A": "x"}); got["A"] != "x" {
		t.Fatalf("missing previous config must leave overrides untouched: %#v", got)
	}

	var previousImage image.InspectResponse
	if err := json.Unmarshal([]byte(`{"Config":{
		"Env":["A=default","B=default","C=default"],
		"Cmd":["serve"],
		"User":"app",
		"Healthcheck":{"Test":["CMD","true"]}
	}}`), &previousImage); err != nil {
		t.Fatalf("decode image: %v", err)
	}
	overrides := dropInheritedImageDefaults(config, &previousImage, map[string]string{"A": "default", "C": "changed"})
	if !slices.Equal(config.Env, []string{"B=custom"}) {
		t.Fatalf("env = %#v", config.Env)
	}
	if _, restated := overrides["A"]; restated || overrides["C"] != "changed" {
		t.Fatalf("overrides = %#v", overrides)
	}
	// Cmd next to an explicit entrypoint was set explicitly and is kept.
	if !slices.Equal(config.Cmd, []string{"serve"}) || !slices.Equal(config.Entrypoint, []string{"/custom-entrypoint"}) {
		t.Fatalf("cmd=%#v entrypoint=%#v", config.Cmd, config.Entrypoint)
	}
	if config.User != "1000" || config.Healthcheck != nil {
		t.Fatalf("user=%q healthcheck=%#v", config.User, config.Healthcheck)
	}
}

func TestValidateUserWorkloadNetworkModeRejectsSharedAndManagedNetworks(t *testing.T) {
	// gateway-db-* stays allowed: HA placements of database-bound workloads
	// are created directly on the managed database network.
	for _, mode := range []string{"", "bridge", "default", "none", "app-net", "gateway-db-0123456789abcdef"} {
		if err := validateUserWorkloadNetworkMode(mode); err != nil {
			t.Fatalf("mode %q rejected: %v", mode, err)
		}
	}
	for _, mode := range []string{"host", "container:abc", "gateway-secure-links"} {
		if err := validateUserWorkloadNetworkMode(mode); err == nil {
			t.Fatalf("mode %q accepted", mode)
		}
	}
	if _, _, err := (&Client{}).CreateContainer(context.Background(), `{"name":"x","image":"busybox","network_mode":"host"}`); err == nil ||
		!strings.Contains(err.Error(), "host networking") {
		t.Fatalf("create with host network error = %v", err)
	}
}

// HA placement and adoption containers of database-bound workloads are created
// with network_mode set to the managed database network.
func TestCreateContainerAllowsManagedDatabaseNetworkMode(t *testing.T) {
	var gotNetworkMode string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/containers/create") {
			http.NotFound(w, r)
			return
		}
		var body struct {
			HostConfig struct {
				NetworkMode string
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode create body: %v", err)
		}
		gotNetworkMode = body.HostConfig.NetworkMode
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"Id":"placement-1","Warnings":[]}`))
	}))
	defer server.Close()
	cli, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	defer cli.Close()

	id, _, err := (&Client{cli: cli, logger: slog.Default()}).CreateContainer(
		context.Background(),
		`{"name":"app-ha-placement","image":"busybox","network_mode":"gateway-db-0123456789abcdef"}`,
	)
	if err != nil {
		t.Fatalf("create on managed database network: %v", err)
	}
	if id != "placement-1" || gotNetworkMode != "gateway-db-0123456789abcdef" {
		t.Fatalf("id=%q networkMode=%q", id, gotNetworkMode)
	}
}
