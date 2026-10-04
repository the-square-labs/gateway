package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

// fakeClickHouseDocker is a Docker Engine API for one running ClickHouse
// container. The server accepts the owner password it last read from the
// bind-mounted owner override: at start, on a restart and, when reloads is
// set, on SYSTEM RELOAD CONFIG.
type fakeClickHouseDocker struct {
	t        *testing.T
	mu       sync.Mutex
	override string
	binds    []string
	reloads  bool
	served   string
	exits    map[string]int
	calls    []string
}

var (
	fakeClickHousePath     = regexp.MustCompile(`^/v[0-9.]+/(containers|exec)/([^/]+)(/[a-z]+)?$`)
	fakeClickHousePassword = regexp.MustCompile(`<password replace="replace">([^<]*)</password>`)
)

func (d *fakeClickHouseDocker) client() *Client {
	d.t.Helper()
	server := httptest.NewServer(http.HandlerFunc(d.serve))
	d.t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://"+strings.TrimPrefix(server.URL, "http://")), client.WithAPIVersion("1.47"))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

// readOverride is the password the server takes from the owner override.
func (d *fakeClickHouseDocker) readOverride() {
	raw, err := os.ReadFile(d.override)
	if err != nil {
		d.t.Fatal(err)
	}
	match := fakeClickHousePassword.FindStringSubmatch(string(raw))
	if match == nil {
		d.t.Fatalf("owner override %q names no password", raw)
	}
	d.served = match[1]
}

func (d *fakeClickHouseDocker) serve(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	reply := func(code int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	match := fakeClickHousePath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	kind, id, action := match[1], match[2], match[3]
	switch {
	case kind == "containers" && action == "/json":
		reply(http.StatusOK, map[string]any{"Id": id, "State": map[string]any{"Running": true}, "HostConfig": map[string]any{"Binds": d.binds}})
	case kind == "containers" && action == "/restart":
		d.calls = append(d.calls, "restart")
		d.readOverride()
		reply(http.StatusNoContent, nil)
	case kind == "containers" && action == "/exec":
		var body struct {
			Cmd []string
			Env []string
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			d.t.Errorf("decode exec create: %v", err)
		}
		signedIn := slices.Contains(body.Env, "CLICKHOUSE_PASSWORD="+d.served)
		query := body.Cmd[len(body.Cmd)-1]
		exit := 0
		switch {
		case !signedIn:
			exit = 1
		case query == "SYSTEM RELOAD CONFIG":
			d.calls = append(d.calls, "reload")
			if d.reloads {
				d.readOverride()
			}
		}
		execID := fmt.Sprintf("exec%d", len(d.exits))
		d.exits[execID] = exit
		reply(http.StatusCreated, map[string]string{"Id": execID})
	case kind == "exec" && action == "/start":
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			d.t.Errorf("hijack exec start: %v", err)
			return
		}
		_, _ = io.WriteString(connection, "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = connection.Close()
	case kind == "exec" && action == "/json":
		reply(http.StatusOK, map[string]any{"ID": id, "ExitCode": d.exits[id]})
	default:
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
	}
}

// Rotating the ClickHouse owner password, which every create does, reloads
// the running server instead of restarting it; a server that does not take
// the reloaded password is restarted as before.
func TestClickHouseOwnerRotationReloadsInsteadOfRestarting(t *testing.T) {
	previous := clickHouseOwnerReloadTimeout
	clickHouseOwnerReloadTimeout = time.Second
	t.Cleanup(func() { clickHouseOwnerReloadTimeout = previous })
	for _, tc := range []struct {
		name      string
		reloads   bool
		wantCalls []string
	}{
		{name: "server reloads", reloads: true, wantCalls: []string{"reload"}},
		{name: "server keeps the old password", wantCalls: []string{"reload", "restart"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &managedDatabaseManager{root: t.TempDir(), logger: slog.New(slog.DiscardHandler)}
			record := managedDatabaseRecord{ID: "db1", Type: "clickhouse", ContainerID: "c1", MountPath: t.TempDir()}
			override := clickHouseOwnerOverridePath(record)
			if err := writeClickHouseOwnerOverride(override, clickHouseOwnerOverrideConfig("owner", "bootstrap-password")); err != nil {
				t.Fatal(err)
			}
			docker := &fakeClickHouseDocker{
				t: t, override: override, reloads: tc.reloads, exits: map[string]int{},
				binds: []string{override + ":" + clickHouseOwnerOverrideContainerPath + ":ro"},
			}
			docker.readOverride()
			m.client = docker.client()
			input := managedDatabaseOwnerSeparationCommand{
				OperationID: "op1", DatabaseName: "app", ApplicationPrincipalName: "gw_app_db1",
				CurrentOwnerUsername: "owner", CurrentOwnerPassword: "bootstrap-password",
				PendingOwnerUsername: "owner", PendingOwnerPassword: "rotated-password",
			}

			if err := m.rotateClickHouseOwner(context.Background(), record, input); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(docker.calls, tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", docker.calls, tc.wantCalls)
			}
			if docker.served != "rotated-password" {
				t.Fatalf("server accepts %q, want the rotated password", docker.served)
			}
		})
	}
}
