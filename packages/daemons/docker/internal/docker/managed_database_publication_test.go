package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// fakePublicationDocker is a Docker Engine API for one managed database
// recreate. It keeps the port bindings each container was created with and
// answers every engine readiness command with success.
type fakePublicationDocker struct {
	t        *testing.T
	mu       sync.Mutex
	calls    []string
	bindings map[string]network.PortMap
	// published are the host ports a started container listens on.
	published map[string]network.PortMap
	running   map[string]bool
	// takenStarts is how many starts Docker refuses with a port conflict.
	takenStarts int
}

var fakePublicationPath = regexp.MustCompile(`^/v[0-9.]+/(containers|exec|images)/(.+?)(/json|/start|/stop|/rename|/exec)?$`)

func (d *fakePublicationDocker) client() *Client {
	d.t.Helper()
	server := httptest.NewServer(http.HandlerFunc(d.serve))
	d.t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://"+strings.TrimPrefix(server.URL, "http://")), client.WithAPIVersion("1.47"))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (d *fakePublicationDocker) serve(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	reply := func(code int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	match := fakePublicationPath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	kind, id, action := match[1], match[2], match[3]
	switch {
	case kind == "images":
		reply(http.StatusOK, map[string]string{"Id": "sha256:engine"})
	case kind == "containers" && id == "create":
		var body struct {
			HostConfig container.HostConfig
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			d.t.Errorf("decode container create: %v", err)
			reply(http.StatusBadRequest, map[string]string{"message": err.Error()})
			return
		}
		created := fmt.Sprintf("c%d", len(d.bindings))
		d.bindings[created] = body.HostConfig.PortBindings
		d.calls = append(d.calls, "create "+created)
		reply(http.StatusCreated, map[string]any{"Id": created, "Warnings": []string{}})
	case kind == "containers" && action == "/start":
		d.calls = append(d.calls, "start "+id)
		if d.takenStarts > 0 {
			d.takenStarts--
			reply(http.StatusInternalServerError, map[string]string{"message": "driver failed programming external connectivity on endpoint gwdb-db1: Bind for 0.0.0.0:1 failed: port is already allocated"})
			return
		}
		// Docker picks a host port for an empty HostPort on every start.
		published := network.PortMap{}
		for port, values := range d.bindings[id] {
			for _, value := range values {
				if value.HostPort == "" {
					value.HostPort = strconv.Itoa(40000 + len(d.calls))
				}
				published[port] = append(published[port], value)
			}
		}
		d.published[id] = published
		d.running[id] = true
		reply(http.StatusNoContent, nil)
	case kind == "containers" && action == "/stop":
		d.calls = append(d.calls, "stop "+id)
		d.running[id] = false
		reply(http.StatusNoContent, nil)
	case kind == "containers" && action == "/rename":
		d.calls = append(d.calls, "rename "+id)
		reply(http.StatusNoContent, nil)
	case kind == "containers" && action == "/json":
		reply(http.StatusOK, map[string]any{
			"Id":              id,
			"State":           map[string]any{"Running": d.running[id]},
			"HostConfig":      map[string]any{"PortBindings": d.bindings[id]},
			"NetworkSettings": map[string]any{"Ports": d.published[id]},
		})
	case kind == "containers" && action == "" && r.Method == http.MethodDelete:
		d.calls = append(d.calls, "remove "+id)
		delete(d.running, id)
		reply(http.StatusNoContent, nil)
	case kind == "containers" && action == "/exec":
		reply(http.StatusCreated, map[string]string{"Id": "exec-" + id})
	case kind == "exec" && action == "/start":
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			d.t.Errorf("hijack exec start: %v", err)
			return
		}
		_, _ = io.WriteString(connection, "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = connection.Close()
	case kind == "exec" && action == "/json":
		reply(http.StatusOK, map[string]any{"ID": id, "ExitCode": 0})
	default:
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
	}
}

func (d *fakePublicationDocker) count(prefix string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	count := 0
	for _, call := range d.calls {
		if strings.HasPrefix(call, prefix) {
			count++
		}
	}
	return count
}

func boundHostPort(t *testing.T, bindings network.PortMap, port string) uint16 {
	t.Helper()
	values := bindings[network.MustParsePort(port)]
	if len(values) != 1 {
		t.Fatalf("bindings of %s = %v, want one", port, values)
	}
	parsed, err := strconv.ParseUint(values[0].HostPort, 10, 16)
	if err != nil || parsed == 0 {
		t.Fatalf("host port of %s = %q, want a chosen port", port, values[0].HostPort)
	}
	return uint16(parsed)
}

// Publishing a database on a port the node picks starts the engine once (I-1:
// the container was replaced after its first start to pin Docker's pick, so
// the dataset loaded twice), and the binding it is created with is the one a
// later restart or update keeps.
func TestPublishingOnAPickedPortCreatesTheContainerOnce(t *testing.T) {
	cases := []struct {
		name        string
		input       managedDatabaseCommand
		takenStarts int
		creates     int
	}{
		{name: "postgres", input: managedDatabaseCommand{Type: "postgres", PublishTCP: true}, creates: 1},
		{name: "clickhouse with native port", input: managedDatabaseCommand{Type: "clickhouse", PublishTCP: true, PublishNativeTCP: true}, creates: 1},
		{name: "postgres on a port taken before Docker bound it", input: managedDatabaseCommand{Type: "postgres", PublishTCP: true}, takenStarts: 1, creates: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			docker := &fakePublicationDocker{
				t: t, bindings: map[string]network.PortMap{"old": nil}, published: map[string]network.PortMap{},
				running: map[string]bool{"old": true}, takenStarts: tc.takenStarts,
			}
			m := &managedDatabaseManager{root: t.TempDir(), logger: slog.New(slog.DiscardHandler), client: docker.client()}
			record := &managedDatabaseRecord{
				ID: "db1", Type: tc.input.Type, ContainerID: "old", ContainerName: "gwdb-db1", NetworkName: "gwdb-db1-net",
				MountPath: t.TempDir(), DesiredRunning: true,
			}
			input := tc.input
			input.Image, input.OwnerUsername, input.OwnerPassword, input.DatabaseName = "engine:1", "owner", "secret", "app"
			ctx := context.Background()

			if err := m.recreateContainer(ctx, record, input); err != nil {
				t.Fatal(err)
			}
			if got := docker.count("create "); got != tc.creates {
				t.Fatalf("creates = %d (%v), want %d", got, docker.calls, tc.creates)
			}
			if got := docker.count("start "); got != tc.creates {
				t.Fatalf("starts = %d (%v), want %d", got, docker.calls, tc.creates)
			}
			// Every container that did not become the instance is gone: the
			// previous one and one refused for its port.
			if got := docker.count("remove "); got != tc.creates {
				t.Fatalf("removes = %d (%v), want %d", got, docker.calls, tc.creates)
			}
			final := docker.bindings[record.ContainerID]
			_, primary := engineDataPathAndPort(input.Type, input.TLSEnabled)
			if port := boundHostPort(t, final, primary); record.PublishedPort != port {
				t.Fatalf("recorded port = %d, container binds %d", record.PublishedPort, port)
			}
			if input.PublishNativeTCP {
				native := boundHostPort(t, final, clickHouseNativePort(input.TLSEnabled))
				if record.PublishedNativePort != native || native == record.PublishedPort {
					t.Fatalf("recorded native port = %d, container binds %d next to %d", record.PublishedNativePort, native, record.PublishedPort)
				}
			}

			// The controller sends the reported ports back on later commands;
			// the binding needs no further pinning.
			next := input
			next.PublishedPort, next.PublishedNativePort = record.PublishedPort, record.PublishedNativePort
			if managedDatabaseContainerSettingsChanged(*record, next) {
				t.Fatal("reported ports read as a publication change")
			}
			needsPinning, err := m.publicationNeedsPinning(ctx, *record, next)
			if err != nil {
				t.Fatal(err)
			}
			if needsPinning {
				t.Fatalf("binding %v needs pinning again", final)
			}

			// A controller that has not stored the picked ports yet sends 0 for
			// them: the update keeps the ports the container publishes instead
			// of replacing it on new ones.
			unsettled := input
			keepAssignedHostPorts(*record, &unsettled)
			if unsettled.PublishedPort != record.PublishedPort || unsettled.PublishedNativePort != record.PublishedNativePort {
				t.Fatalf("ports left to the node = %d/%d, want the published %d/%d",
					unsettled.PublishedPort, unsettled.PublishedNativePort, record.PublishedPort, record.PublishedNativePort)
			}
			if managedDatabaseRequiresRecreate(*record, unsettled) {
				t.Fatal("ports left to the node read as a publication change")
			}
			if needsPinning, err := m.publicationNeedsPinning(ctx, *record, unsettled); err != nil || needsPinning {
				t.Fatalf("ports left to the node need pinning = %v, %v", needsPinning, err)
			}
		})
	}
}

// A port left to the node is the one it publishes; a publication it has no
// port for yet, or one that is turned off, keeps 0.
func TestPortLeftToTheNodeKeepsTheAssignedPort(t *testing.T) {
	published := managedDatabaseRecord{Type: "clickhouse", PublishedPort: 35481, PublishedNativePort: 35482}
	for _, tc := range []struct {
		name               string
		record             managedDatabaseRecord
		input              managedDatabaseCommand
		wantPort, wantNatv uint16
	}{
		{name: "published", record: published, input: managedDatabaseCommand{PublishTCP: true, PublishNativeTCP: true}, wantPort: 35481, wantNatv: 35482},
		{name: "native turned off", record: published, input: managedDatabaseCommand{PublishTCP: true}, wantPort: 35481},
		{name: "publication turned off", record: published, input: managedDatabaseCommand{}},
		{name: "chosen port", record: published, input: managedDatabaseCommand{PublishTCP: true, PublishedPort: 5432}, wantPort: 5432},
		{name: "not published yet", record: managedDatabaseRecord{Type: "postgres"}, input: managedDatabaseCommand{PublishTCP: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := tc.input
			keepAssignedHostPorts(tc.record, &input)
			if input.PublishedPort != tc.wantPort || input.PublishedNativePort != tc.wantNatv {
				t.Fatalf("ports = %d/%d, want %d/%d", input.PublishedPort, input.PublishedNativePort, tc.wantPort, tc.wantNatv)
			}
		})
	}
}
