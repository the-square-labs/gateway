package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mobymount "github.com/moby/moby/api/types/mount"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

type shortWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (w *shortWriter) Write(data []byte) (int, error) {
	if len(data) > w.limit {
		data = data[:w.limit]
	}
	return w.buffer.Write(data)
}

func TestDatabaseTunnelHandshakeRoundTripWithShortWrites(t *testing.T) {
	bindingID := "33333333-3333-4333-8333-333333333333"
	writer := &shortWriter{limit: 3}
	if err := WriteDatabaseTunnelHandshake(writer, bindingID); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	data := writer.buffer.Bytes()
	if string(data[:len(DatabaseTunnelHandshakeMagic)]) != DatabaseTunnelHandshakeMagic {
		t.Fatalf("unexpected handshake magic: %q", data[:len(DatabaseTunnelHandshakeMagic)])
	}
	lengthOffset := len(DatabaseTunnelHandshakeMagic)
	if length := binary.BigEndian.Uint16(data[lengthOffset : lengthOffset+2]); int(length) != len(bindingID) {
		t.Fatalf("unexpected binding length: %d", length)
	}
	got, err := readDatabaseTunnelHandshake(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("read handshake: %v", err)
	}
	if got != bindingID {
		t.Fatalf("binding id mismatch: got %q want %q", got, bindingID)
	}
}

func TestDatabaseTunnelHandshakeRejectsInvalidInput(t *testing.T) {
	if err := WriteDatabaseTunnelHandshake(io.Discard, ""); err == nil {
		t.Fatal("expected empty binding id to be rejected")
	}
	if err := WriteDatabaseTunnelHandshake(io.Discard, strings.Repeat("a", databaseTunnelHandshakeLimit+1)); err == nil {
		t.Fatal("expected oversized binding id to be rejected")
	}
	invalidLength := append([]byte(DatabaseTunnelHandshakeMagic), 0, 0)
	if _, err := readDatabaseTunnelHandshake(bytes.NewReader(invalidLength)); err == nil {
		t.Fatal("expected zero binding length to be rejected")
	}
}

func TestDatabaseTunnelCapabilitiesUseSeparateV2Lanes(t *testing.T) {
	bindingID := "33333333-3333-4333-8333-333333333333"
	if got, want := databaseTunnelCapability("data", bindingID), databaseTunnelCapabilityPrefix+"data:"+bindingID; got != want {
		t.Fatalf("unexpected data capability: got %q want %q", got, want)
	}
	if got, want := databaseTunnelCapability("interactive", ""), databaseTunnelCapabilityPrefix+"interactive"; got != want {
		t.Fatalf("unexpected interactive capability: got %q want %q", got, want)
	}
	if got, want := databaseTunnelCapability("monitoring", ""), databaseTunnelCapabilityPrefix+"monitoring"; got != want {
		t.Fatalf("unexpected monitoring capability: got %q want %q", got, want)
	}
}

func TestDatabaseProfileDispatchesBindingPreparation(t *testing.T) {
	bindingID := "33333333-3333-4333-8333-333333333333"
	databaseID := "44444444-4444-4444-8444-444444444444"
	registry, err := newDatabaseBindingRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("create binding registry: %v", err)
	}
	plugin := &DockerPlugin{
		cfg:              &config.Config{Docker: config.DockerConfig{Mode: "databases"}},
		databaseBindings: registry,
	}

	result := plugin.HandleCommand(&pb.GatewayCommand{
		Payload: &pb.GatewayCommand_DockerDatabaseBinding{DockerDatabaseBinding: &pb.DockerDatabaseBindingCommand{
			Action:            "prepare",
			BindingId:         bindingID,
			ManagedDatabaseId: databaseID,
		}},
	})
	if result.Success || result.Error != "database tunnel is not connected" {
		t.Fatalf("binding preparation was not dispatched to its handler: success=%v error=%q", result.Success, result.Error)
	}
	if got, ok := registry.resolve(bindingID); !ok || got != databaseID {
		t.Fatalf("binding registry was not prepared: got %q, ok=%v", got, ok)
	}

	capabilities := plugin.BuildRegisterMessage("node-id").Capabilities
	advertisesBindings := false
	for _, capability := range capabilities {
		if capability == "docker_database_bindings_v1" {
			advertisesBindings = true
			break
		}
	}
	if !advertisesBindings {
		t.Fatalf("database-profile daemon did not advertise binding support: %v", capabilities)
	}
}

func TestDatabaseTunnelRouterRevokesOnlyTheRemovedBindingLane(t *testing.T) {
	firstBindingID := "33333333-3333-4333-8333-333333333333"
	secondBindingID := "44444444-4444-4444-8444-444444444444"
	firstContext, firstCancel := context.WithCancel(context.Background())
	secondContext, secondCancel := context.WithCancel(context.Background())
	defer firstCancel()
	defer secondCancel()
	router := &databaseTunnelRouter{slots: map[string]*databaseTunnelSlot{
		databaseTunnelLaneKey("data", firstBindingID): {
			cancel:    firstCancel,
			transport: &databaseTunnelTransport{sessions: make(map[string]*databaseTunnelSession)},
		},
		databaseTunnelLaneKey("data", secondBindingID): {
			cancel:    secondCancel,
			transport: &databaseTunnelTransport{sessions: make(map[string]*databaseTunnelSession)},
		},
	}}

	router.closeBinding(firstBindingID)
	select {
	case <-firstContext.Done():
	default:
		t.Fatal("expected removed binding lane to be cancelled")
	}
	select {
	case <-secondContext.Done():
		t.Fatal("unexpected cancellation of another binding lane")
	default:
	}
	if router.transportForBinding(firstBindingID) != nil {
		t.Fatal("expected removed binding lane to be unavailable")
	}
	if router.transportForBinding(secondBindingID) == nil {
		t.Fatal("expected another binding lane to remain available")
	}
}

func TestDatabaseBindingRegistryPersistsAndRejectsRemap(t *testing.T) {
	dir := t.TempDir()
	bindingID := "33333333-3333-4333-8333-333333333333"
	databaseID := "44444444-4444-4444-8444-444444444444"
	registry, err := newDatabaseBindingRegistry(dir)
	if err != nil {
		t.Fatalf("create registry: %v", err)
	}
	if err := registry.prepare(bindingID, databaseID); err != nil {
		t.Fatalf("prepare binding: %v", err)
	}
	if err := registry.prepare(bindingID, "55555555-5555-4555-8555-555555555555"); err == nil {
		t.Fatal("expected remap to another database to be rejected")
	}

	reloaded, err := newDatabaseBindingRegistry(dir)
	if err != nil {
		t.Fatalf("reload registry: %v", err)
	}
	if got, ok := reloaded.resolve(bindingID); !ok || got != databaseID {
		t.Fatalf("persisted mapping mismatch: got %q, ok=%v", got, ok)
	}
	info, err := os.Stat(filepath.Join(dir, "database-bindings.json"))
	if err != nil {
		t.Fatalf("stat registry: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("registry permissions = %o, want 600", info.Mode().Perm())
	}
	if err := reloaded.remove(bindingID, "55555555-5555-4555-8555-555555555555"); err == nil {
		t.Fatal("expected removal with a mismatched database id to be rejected")
	}
	if err := reloaded.remove(bindingID, databaseID); err != nil {
		t.Fatalf("remove binding: %v", err)
	}
	if _, ok := reloaded.resolve(bindingID); ok {
		t.Fatal("binding remains after removal")
	}
}

func TestManagedDatabaseEnginePortsAreFixed(t *testing.T) {
	tests := map[string]string{"postgres": "5432", "redis": "6379", "clickhouse": "8123"}
	for engine, expected := range tests {
		port, err := managedDatabaseEnginePort(engine)
		if err != nil {
			t.Fatalf("resolve %s port: %v", engine, err)
		}
		if port != expected {
			t.Fatalf("%s port = %s, want %s", engine, port, expected)
		}
	}
	if _, err := managedDatabaseEnginePort("mysql"); err == nil {
		t.Fatal("expected unsupported engine to be rejected")
	}
}

func TestReplaceLegacyDatabaseConnectorBindsIsExactAndIdempotent(t *testing.T) {
	stateDir := "/var/lib/docker-daemon"
	legacy := stateDir + "/database-tunnel.sock:/run/gateway-db/tunnel.sock"
	other := "/host/other:/container/other:ro"

	updated, changed := replaceLegacyDatabaseConnectorBinds(stateDir, []string{legacy, other})
	if !changed {
		t.Fatal("expected legacy connector bind to be replaced")
	}
	want := stateDir + "/database-tunnel:/run/gateway-db:ro"
	if updated[0] != want || updated[1] != other {
		t.Fatalf("unexpected updated binds: %#v", updated)
	}

	second, changed := replaceLegacyDatabaseConnectorBinds(stateDir, updated)
	if changed {
		t.Fatal("restart-safe directory bind must not be migrated again")
	}
	if second[0] != want || second[1] != other {
		t.Fatalf("unexpected idempotent binds: %#v", second)
	}
}

func TestReplaceLegacyDatabaseConnectorMountsIsExactAndIdempotent(t *testing.T) {
	stateDir := "/var/lib/docker-daemon"
	legacy := mobymount.Mount{
		Type:   mobymount.TypeBind,
		Source: stateDir + "/database-tunnel.sock",
		Target: "/run/gateway-db/tunnel.sock",
	}
	other := mobymount.Mount{Type: mobymount.TypeBind, Source: "/host/other", Target: "/container/other"}

	updated, changed := replaceLegacyDatabaseConnectorMounts(stateDir, []mobymount.Mount{legacy, other})
	if !changed {
		t.Fatal("expected structured legacy connector mount to be replaced")
	}
	if updated[0].Source != stateDir+"/database-tunnel" || updated[0].Target != "/run/gateway-db" || !updated[0].ReadOnly {
		t.Fatalf("unexpected updated mount: %#v", updated[0])
	}
	if updated[1] != other {
		t.Fatalf("unrelated mount changed: %#v", updated[1])
	}

	second, changed := replaceLegacyDatabaseConnectorMounts(stateDir, updated)
	if changed {
		t.Fatal("restart-safe structured mount must not be migrated again")
	}
	if second[0] != updated[0] || second[1] != other {
		t.Fatalf("unexpected idempotent mounts: %#v", second)
	}
}

func TestReconcileLegacyDatabaseConnectorMountsRecreatesFirstPartyConnector(t *testing.T) {
	stateDir := t.TempDir()
	legacyBind := legacyDatabaseTunnelSocketPath(stateDir) + ":" + databaseConnectorSocketPath
	var created map[string]any
	stopCalls := 0
	removeCalls := 0
	startCalls := 0

	dockerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			_, _ = fmt.Fprintf(w, `[{"Id":"legacy-connector","Names":["/gateway-db-connector"],"Image":"connector:test","State":"running","Labels":{%q:"true"}}]`, databaseConnectorLabel)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/legacy-connector/json"):
			_, _ = fmt.Fprintf(w, `{
				"Id":"legacy-connector",
				"Name":"/gateway-db-connector",
				"Image":"sha256:connector",
				"Config":{"Image":"connector:test","Env":["GATEWAY_DB_SOCKET=/run/gateway-db/tunnel.sock"],"Labels":{%q:"true"}},
				"HostConfig":{"Binds":[%q],"RestartPolicy":{"Name":"unless-stopped"}},
				"State":{"Running":true},
				"NetworkSettings":{"Networks":{"binding-network":{"NetworkID":"network-id","Aliases":["database"]}}}
			}`, databaseConnectorLabel, legacyBind)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/legacy-connector/stop"):
			stopCalls++
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/containers/legacy-connector"):
			removeCalls++
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/create"):
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Errorf("decode recreated connector: %v", err)
			}
			_, _ = w.Write([]byte(`{"Id":"replacement-connector","Warnings":[]}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/replacement-connector/start"):
			startCalls++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "unexpected Docker API request", http.StatusNotFound)
			t.Errorf("unexpected Docker API request: %s %s", r.Method, r.URL.String())
		}
	}))
	defer dockerAPI.Close()

	dockerClient, err := mobyclient.NewClientWithOpts(
		mobyclient.WithHost(dockerAPI.URL),
		mobyclient.WithVersion("1.43"),
	)
	if err != nil {
		t.Fatalf("create Docker API client: %v", err)
	}
	defer dockerClient.Close()

	daemonConfig := &config.Config{}
	daemonConfig.StateDir = stateDir
	plugin := &DockerPlugin{
		cfg:    daemonConfig,
		client: &Client{cli: dockerClient, logger: slog.Default()},
		logger: slog.Default(),
	}
	migrated, err := plugin.reconcileLegacyDatabaseConnectorMounts(t.Context())
	if err != nil {
		t.Fatalf("reconcile legacy connector: %v", err)
	}
	if migrated != 1 {
		t.Fatalf("migrated connectors = %d, want 1", migrated)
	}
	if stopCalls != 1 || removeCalls != 1 || startCalls != 1 {
		t.Fatalf("unexpected lifecycle calls: stop=%d remove=%d start=%d", stopCalls, removeCalls, startCalls)
	}

	hostConfig, ok := created["HostConfig"].(map[string]any)
	if !ok {
		t.Fatalf("recreated connector HostConfig is unavailable: %#v", created)
	}
	binds, ok := hostConfig["Binds"].([]any)
	if !ok || len(binds) != 1 {
		t.Fatalf("unexpected recreated connector binds: %#v", hostConfig["Binds"])
	}
	wantBind := filepath.Join(stateDir, DatabaseTunnelSocketDirectory) + ":" + databaseConnectorSocketDirectory + ":ro"
	if binds[0] != wantBind {
		t.Fatalf("recreated connector bind = %#v, want %q", binds[0], wantBind)
	}

	networking, ok := created["NetworkingConfig"].(map[string]any)
	if !ok {
		t.Fatalf("recreated connector networking config is unavailable: %#v", created)
	}
	endpoints, ok := networking["EndpointsConfig"].(map[string]any)
	if !ok || endpoints["binding-network"] == nil {
		t.Fatalf("binding network was not preserved: %#v", networking)
	}
}

func TestManagedPostgresTunnelPreservesClientSSLRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.2:5432")
	if err != nil {
		t.Skipf("PostgreSQL test endpoint is unavailable: %v", err)
	}
	defer listener.Close()

	const (
		databaseID  = "44444444-4444-4444-8444-444444444444"
		containerID = "managed-postgres-container"
		networkName = "managed-postgres-network"
	)
	dockerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
			"Id": %q,
			"Config": {"Labels": {%q: %q, %q: "postgres"}},
			"State": {"Running": true},
			"NetworkSettings": {"Networks": {%q: {"IPAddress": "127.0.0.2"}}}
		}`, containerID, managedDatabaseLabel, databaseID, managedDatabaseTypeTag, networkName)
	}))
	defer dockerAPI.Close()

	dockerClient, err := mobyclient.NewClientWithOpts(
		mobyclient.WithHost(dockerAPI.URL),
		mobyclient.WithVersion("1.43"),
	)
	if err != nil {
		t.Fatalf("create Docker API client: %v", err)
	}
	defer dockerClient.Close()

	storageRoot := t.TempDir()
	manager, err := newManagedDatabaseManager(
		&config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: storageRoot}}},
		&Client{cli: dockerClient, logger: slog.Default()},
		slog.Default(),
	)
	if err != nil {
		t.Fatalf("create managed database manager: %v", err)
	}
	record := managedDatabaseRecord{
		ID:          databaseID,
		Type:        "postgres",
		ContainerID: containerID,
		NetworkName: networkName,
		ImagePath:   filepath.Join(storageRoot, "images", databaseID+".img"),
		MountPath:   filepath.Join(storageRoot, "mounts", databaseID),
		TLSEnabled:  true,
	}
	if err := manager.saveRecord(record); err != nil {
		t.Fatalf("save managed database record: %v", err)
	}

	type dialResult struct {
		connection net.Conn
		err        error
	}
	dialed := make(chan dialResult, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	go func() {
		connection, dialErr := manager.dial(ctx, databaseID)
		dialed <- dialResult{connection: connection, err: dialErr}
	}()

	serverConnection, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept managed PostgreSQL connection: %v", err)
	}
	defer serverConnection.Close()
	if err := serverConnection.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatalf("set preface observation deadline: %v", err)
	}
	probe := make([]byte, 1)
	if count, readErr := serverConnection.Read(probe); count != 0 {
		t.Fatalf("database daemon eagerly wrote %d protocol bytes before the client", count)
	} else if networkError, ok := readErr.(net.Error); !ok || !networkError.Timeout() {
		t.Fatalf("observe idle managed PostgreSQL connection: %v", readErr)
	}

	var result dialResult
	select {
	case result = <-dialed:
	case <-ctx.Done():
		t.Fatal("managed PostgreSQL dial did not return an opaque connection")
	}
	if result.err != nil {
		t.Fatalf("dial managed PostgreSQL: %v", result.err)
	}
	defer result.connection.Close()
	if err := serverConnection.SetReadDeadline(time.Time{}); err != nil {
		t.Fatalf("clear preface observation deadline: %v", err)
	}

	sslRequest := []byte{0, 0, 0, 8, 4, 210, 22, 47}
	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := result.connection.Write(sslRequest)
		writeDone <- writeErr
	}()
	received := make([]byte, len(sslRequest))
	if _, err := io.ReadFull(serverConnection, received); err != nil {
		t.Fatalf("read forwarded PostgreSQL SSLRequest: %v", err)
	}
	if !bytes.Equal(received, sslRequest) {
		t.Fatalf("PostgreSQL SSLRequest changed in transit: got %v want %v", received, sslRequest)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("write PostgreSQL SSLRequest: %v", err)
	}
}

func TestDatabaseTunnelSessionCapsReleaseAfterClose(t *testing.T) {
	transport := &databaseTunnelTransport{sessions: make(map[string]*databaseTunnelSession)}
	var peers []net.Conn
	for i := 0; i < databaseTunnelMaxSessionsPerBinding; i++ {
		left, right := net.Pipe()
		peers = append(peers, right)
		session, err := transport.addSession(fmt.Sprintf("tunnel-%d", i), "binding-a", left)
		if err != nil || session == nil {
			t.Fatalf("admit session %d: %v", i, err)
		}
	}
	overflow, overflowPeer := net.Pipe()
	defer overflowPeer.Close()
	if _, err := transport.addSession("overflow", "binding-a", overflow); err == nil {
		t.Fatal("expected per-binding session cap")
	}
	_ = overflow.Close()

	transport.finishMatching("tunnel-0", "binding-a", nil)
	retry, retryPeer := net.Pipe()
	peers = append(peers, retryPeer)
	if _, err := transport.addSession("retry", "binding-a", retry); err != nil {
		t.Fatalf("admit after close: %v", err)
	}
	transport.shutdown()
	for _, peer := range peers {
		_ = peer.Close()
	}
}
