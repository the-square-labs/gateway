package daemon

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

const testSecureLinkID = "11111111-1111-4111-8111-111111111111"

func testSourceLinkManager(t *testing.T, opener func(string, net.Conn)) *sourceLinkManager {
	t.Helper()
	manager := newSourceLinkManager(opener)
	directory, err := os.MkdirTemp("/tmp", "gw-sl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	manager.socketDir = directory
	return manager
}

func sourceCommand(port uint32, generation uint64) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: testSecureLinkID, Role: "source", Generation: generation, ListenerPort: port, SourceConfigManaged: true,
	}}}
}

func TestProxySecureLinkSetupTimeoutOnlyCoversHandshake(t *testing.T) {
	t.Run("cancels an unready stream", func(t *testing.T) {
		ctx, cancel, finishSetup := proxySecureLinkSetupContext(context.Background(), 20*time.Millisecond)
		defer cancel()
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("setup context was not cancelled")
		}
		if finishSetup() {
			t.Fatal("expired setup timer reported a successful stop")
		}
	})

	t.Run("keeps a ready stream alive", func(t *testing.T) {
		ctx, cancel, finishSetup := proxySecureLinkSetupContext(context.Background(), 20*time.Millisecond)
		defer cancel()
		if !finishSetup() {
			t.Fatal("ready stream lost the setup timeout race")
		}
		time.Sleep(40 * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Fatal("setup timeout cancelled an established stream")
		default:
		}
	})
}

func TestProxySecureLinkProbeDoesNotRetainIdleConnection(t *testing.T) {
	closed := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		defer connection.Close()
		request, err := http.ReadRequest(bufio.NewReader(connection))
		if err != nil {
			return
		}
		_ = request.Body.Close()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
		_ = connection.SetReadDeadline(time.Now().Add(time.Second))
		_, _ = connection.Read(make([]byte, 1))
		closed <- struct{}{}
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync listener: statuses=%#v err=%v", statuses, err)
	}
	plugin := &NginxPlugin{secureLinks: manager}
	if _, err := plugin.ProbeProxySecureLink(&pb.ProbeProxySecureLinkCommand{
		LinkId: testSecureLinkID, Scheme: "http", Path: "/", ExpectedStatus: 200, TimeoutSeconds: 1,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("health probe retained an idle secure-link connection")
	}
}

func TestSourceLinkManagerAllocatesReusesAndReallocatesPorts(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(statuses) != 1 || statuses[0].Port == 0 {
		t.Fatalf("initial sync: statuses=%#v err=%v", statuses, err)
	}
	allocated := statuses[0].Port
	statuses, err = manager.sync(sourceCommand(uint32(allocated), 2))
	if err != nil || statuses[0].Port != allocated {
		t.Fatalf("reuse sync: statuses=%#v err=%v", statuses, err)
	}
	if _, err := manager.sync(&pb.SyncProxySecureLinksCommand{}); err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", stringPort(allocated)))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()

	restarted := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err = restarted.sync(sourceCommand(uint32(allocated), 2))
	if err != nil || statuses[0].Port == allocated || statuses[0].Port == 0 {
		t.Fatalf("conflict sync: statuses=%#v err=%v", statuses, err)
	}
	reallocated := statuses[0].Port
	statuses, err = restarted.sync(sourceCommand(uint32(allocated), 3))
	if err != nil || statuses[0].Port != reallocated {
		t.Fatalf("stale control-plane port caused listener churn: statuses=%#v err=%v", statuses, err)
	}
}

func TestSourceLinkManagerRejectedSnapshotKeepsThePreviousSet(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	secondID := "22222222-2222-4222-8222-222222222222"
	initial := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: testSecureLinkID, Role: "source", Generation: 2},
		{LinkId: secondID, Role: "source", Generation: 2},
	}}
	before, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.sync(sourceCommand(0, 1)); err == nil {
		t.Fatal("expected stale snapshot to fail")
	}
	after, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 || before[0].Port != after[0].Port || before[1].Port != after[1].Port {
		t.Fatalf("rejected snapshot mutated listeners: before=%#v after=%#v", before, after)
	}
}

func TestSourceLinkManagerRotatesListenerBeforeActiveTargetCutover(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	before, err := manager.sync(sourceCommand(0, 2))
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(uint32(before[0].Port), 3)
	command.Bindings[0].RotateListener = true
	command.Bindings[0].SourceConfigManaged = false
	after, err := manager.sync(command)
	if err != nil {
		t.Fatal(err)
	}
	if after[0].Port == before[0].Port {
		t.Fatal("active update reused the production listener")
	}
	if connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(before[0].Port)), 100*time.Millisecond); err == nil {
		_ = connection.Close()
		t.Fatal("retired production listener still accepts traffic")
	}
}

func TestSourceLinkRemovalClosesActiveConnections(t *testing.T) {
	accepted := make(chan struct{})
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		close(accepted)
		_, _ = io.Copy(io.Discard, connection)
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(statuses[0].Port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("listener did not accept connection")
	}
	if _, err := manager.sync(&pb.SyncProxySecureLinksCommand{}); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected active connection to close")
	}
}

func TestSourceLinkGrantRevocationClosesActiveConnectionButKeepsListener(t *testing.T) {
	accepted := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		select {
		case accepted <- struct{}{}:
		default:
		}
		_, _ = io.Copy(io.Discard, connection)
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	address := net.JoinHostPort("127.0.0.1", stringPort(statuses[0].Port))
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("listener did not accept connection")
	}

	manager.closeActive(testSecureLinkID)
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected revoked connection to close")
	}

	reconnected, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("listener was removed by grant revocation: %v", err)
	}
	_ = reconnected.Close()
}

func stringPort(port int) string {
	return strconv.Itoa(port)
}

func TestReconcileRestoredSecureLinkPortsAtomicallyUpdatesProxyPass(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{
		mgr:    manager,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	path := manager.ConfigPath(testSecureLinkID)
	original := "location / {\n  # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n  proxy_pass https://127.0.0.1:41000;\n}\nlocation /secondary {\n  proxy_pass http://127.0.0.1:9999;\n}\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	restored := sourceCommand(41000, 2)
	statuses := []sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}}

	if err := plugin.reconcileRestoredSecureLinkPorts(restored, statuses); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	actual := string(content)
	if !strings.Contains(actual, "proxy_pass https://127.0.0.1:42000;") {
		t.Fatalf("recovered config did not use new listener port: %s", actual)
	}
	if !strings.Contains(actual, "proxy_pass http://127.0.0.1:9999;") {
		t.Fatalf("recovery changed a secondary loopback proxy_pass: %s", actual)
	}
}

func TestReconcileRestoredSecureLinkPortsNeverRewritesUnmarkedRawConfig(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location /one { proxy_pass http://127.0.0.1:9000; }\n# gateway-managed-secure-link-upstream 22222222-2222-4222-8222-222222222222\nproxy_pass http://127.0.0.1:41000;\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := plugin.reconcileRestoredSecureLinkPorts(
		sourceCommand(41000, 2),
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, original) {
		t.Fatalf("raw config was rewritten: %s", content)
	}
}

func TestReconcileRestoredSecureLinkPortsNeverRewritesUserOwnedCopiedManagedConfig(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location / {\n # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n proxy_pass http://127.0.0.1:41000;\n}\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := sourceCommand(41000, 2)
	restored.Bindings[0].SourceConfigManaged = false
	if err := plugin.reconcileRestoredSecureLinkPorts(
		restored,
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, original) {
		t.Fatalf("user-owned copied config was rewritten: %s", content)
	}
}

func TestApplyRawConfigDurablyDropsManagedRecoveryOwnershipBeforeWriting(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	manager := nginx.NewManager(trueBinary, t.TempDir(), t.TempDir(), "")
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(41000, 2)
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}
	handler := &Handler{
		mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), secureLinkState: store,
	}
	result := &pb.CommandResult{Success: true}
	handler.handleApplyConfig(&pb.ApplyConfigCommand{
		HostId: testSecureLinkID,
		ConfigContent: "# gateway-managed-secure-link-upstream " + testSecureLinkID +
			"\nproxy_pass http://127.0.0.1:41000;\n",
		ConfigOwnership: configOwnershipUserOwned,
	}, result)
	if !result.Success {
		t.Fatalf("apply raw config: %s", result.Error)
	}
	if store.Get().Bindings[0].SourceConfigManaged {
		t.Fatal("raw config retained managed restart-rewrite ownership")
	}
}

func TestApplyManagedConfigClaimsRecoveryOwnershipBeforeNginxValidation(t *testing.T) {
	stateDir := t.TempDir()
	store, err := securelink.NewStateStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(42000, 3)
	command.Bindings[0].SourceConfigManaged = false // listener was rotated for an active target update
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}

	checker := filepath.Join(t.TempDir(), "nginx-check")
	statePath := filepath.Join(stateDir, "proxy-secure-links.json")
	script := "#!/bin/sh\ngrep -q '\"source_config_managed\":true' " + strconv.Quote(statePath) + "\n"
	if err := os.WriteFile(checker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := nginx.NewManager(checker, t.TempDir(), t.TempDir(), "")
	handler := &Handler{
		mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), secureLinkState: store,
	}
	result := &pb.CommandResult{Success: true}
	handler.handleApplyConfig(&pb.ApplyConfigCommand{
		HostId:          testSecureLinkID,
		ConfigContent:   "# gateway-managed-secure-link-upstream " + testSecureLinkID + "\nproxy_pass http://127.0.0.1:42000;\n",
		ConfigOwnership: configOwnershipManagedSecureLink,
	}, result)
	if !result.Success {
		t.Fatalf("apply managed config: %s", result.Error)
	}
	if !store.Get().Bindings[0].SourceConfigManaged {
		t.Fatal("managed config did not claim restart-rewrite ownership")
	}
}

func TestReconcileRestoredSecureLinkPortsRollsBackInvalidConfig(t *testing.T) {
	falseBinary, err := exec.LookPath("false")
	if err != nil {
		t.Skip("false binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(falseBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{
		mgr:    manager,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location / {\n # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n proxy_pass http://127.0.0.1:41000;\n}\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	err = plugin.reconcileRestoredSecureLinkPorts(
		sourceCommand(41000, 2),
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	)
	if err == nil {
		t.Fatal("expected nginx config validation failure")
	}
	content, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(content) != string(original) {
		t.Fatalf("config was not rolled back: %s", content)
	}
}
