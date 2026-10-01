package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	testListenerNetwork  = "gateway-db-0123456789abcdef"
	testListenerBindingA = "binding-a"
	testListenerBindingB = "binding-b"
)

// lockedLog collects a test logger's lines.
type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) lines(substrings ...string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var matched []string
	for _, line := range strings.Split(l.buf.String(), "\n") {
		all := line != ""
		for _, substring := range substrings {
			all = all && strings.Contains(line, substring)
		}
		if all {
			matched = append(matched, line)
		}
	}
	return matched
}

func newTestLogger() (*slog.Logger, *lockedLog) {
	output := &lockedLog{}
	return slog.New(slog.NewTextHandler(output, &slog.HandlerOptions{Level: slog.LevelDebug})), output
}

// listenerHarness runs a host listener manager on loopback: the binding network's gateway is 127.0.0.1 and every
// peer is the deployment's container. Connections that reach the relay side are held until the test ends.
type listenerHarness struct {
	t       *testing.T
	manager *managedDatabaseHostListenerManager
	log     *lockedLog
	port    uint16

	mu         sync.Mutex
	inspectErr error
	opened     []openedBinding
	openedCh   chan struct{}
	release    chan struct{}
}

type openedBinding struct {
	bindingID  string
	generation uint64
}

func newListenerHarness(t *testing.T) *listenerHarness {
	t.Helper()
	logger, output := newTestLogger()
	h := &listenerHarness{t: t, log: output, port: freeLoopbackPort(t), openedCh: make(chan struct{}, 1024), release: make(chan struct{})}
	h.manager = &managedDatabaseHostListenerManager{
		logger:    logger,
		listeners: map[string]*managedDatabaseHostListener{},
		global:    make(chan struct{}, managedDatabaseHostListenerGlobalConnections),
		inspectNetwork: func(context.Context, string) (network.Inspect, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.inspectErr != nil {
				return network.Inspect{}, h.inspectErr
			}
			return network.Inspect{
				Network: network.Network{Name: testListenerNetwork, ID: "network-1", Driver: "bridge",
					IPAM: network.IPAM{Config: []network.IPAMConfig{{Gateway: netip.MustParseAddr("127.0.0.1")}}}},
				Containers: map[string]network.EndpointResource{"container-1": {IPv4Address: netip.MustParsePrefix("127.0.0.1/8")}},
			}, nil
		},
		inspectContainer: func(context.Context, string) (mobyclient.ContainerInspectResult, error) {
			return mobyclient.ContainerInspectResult{Container: container.InspectResponse{Name: "/app-blue",
				Config: &container.Config{Labels: map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "deployment-1"}}}}, nil
		},
		openBinding: func(_ net.Conn, bindingID string, generation uint64) {
			h.mu.Lock()
			h.opened = append(h.opened, openedBinding{bindingID: bindingID, generation: generation})
			h.mu.Unlock()
			h.openedCh <- struct{}{}
			<-h.release
		},
	}
	t.Cleanup(func() {
		close(h.release)
		h.manager.mu.Lock()
		for _, listener := range h.manager.listeners {
			listener.close()
		}
		h.manager.mu.Unlock()
	})
	return h
}

func freeLoopbackPort(t *testing.T) uint16 {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return uint16(listener.Addr().(*net.TCPAddr).Port)
}

func (h *listenerHarness) assignment(bindingID string, generation uint64, sessions uint32) *pb.RelayGrantAssignment {
	payload := []byte(`{"kind":"connect"}`)
	if sessions > 0 {
		payload, _ = json.Marshal(map[string]any{"kind": "connect", "maxConcurrentSessions": sessions})
	}
	return &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: "managed_database_binding", OwnerId: bindingID,
		Grant: &pb.RelaySignedGrant{KeyId: "key-1", Payload: payload, Signature: []byte("signature")},
		ManagedDatabaseListener: &pb.ManagedDatabaseListener{NetworkName: testListenerNetwork, ListenAddress: "127.0.0.1",
			ListenPort: uint32(h.port), AllowedSources: []string{"deployment:deployment-1"}, RouteGeneration: generation},
	}
}

func (h *listenerHarness) reconcile(assignments ...*pb.RelayGrantAssignment) map[string]managedDatabaseHostListenerStatus {
	return h.manager.reconcile(context.Background(), &pb.SyncRelayGrantsCommand{Grants: assignments})
}

func (h *listenerHarness) setInspectError(err error) {
	h.mu.Lock()
	h.inspectErr = err
	h.mu.Unlock()
}

func (h *listenerHarness) listener(bindingID string) *managedDatabaseHostListener {
	h.manager.mu.Lock()
	defer h.manager.mu.Unlock()
	return h.manager.listeners[bindingID]
}

func (h *listenerHarness) dial() net.Conn {
	h.t.Helper()
	connection, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprint(h.port)), time.Second)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { connection.Close() })
	return connection
}

// waitOpened waits until count more connections reached the relay side.
func (h *listenerHarness) waitOpened(count int) {
	h.t.Helper()
	deadline := time.After(5 * time.Second)
	for range count {
		select {
		case <-h.openedCh:
		case <-deadline:
			h.t.Fatalf("connections did not reach the binding")
		}
	}
}

func (h *listenerHarness) openedBindings() []openedBinding {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]openedBinding(nil), h.opened...)
}

// requireOpen fails when the listener closed one of connections: a held connection reads nothing until the deadline.
func requireOpen(t *testing.T, connections ...net.Conn) {
	t.Helper()
	deadline := time.Now().Add(100 * time.Millisecond)
	results := make(chan error, len(connections))
	for _, connection := range connections {
		go func() {
			_ = connection.SetReadDeadline(deadline)
			_, err := connection.Read(make([]byte, 1))
			_ = connection.SetReadDeadline(time.Time{})
			results <- err
		}()
	}
	for range connections {
		err := <-results
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("held connection was closed: %v", err)
		}
	}
}

func requireClosed(t *testing.T, connection net.Conn) {
	t.Helper()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := connection.Read(make([]byte, 1))
	if err == nil || (!errors.Is(err, io.EOF) && !strings.Contains(err.Error(), "reset")) {
		t.Fatalf("connection was not closed: %v", err)
	}
}

// One binding carries 40 concurrent connections (a deployment's two slots during a rollout). Its listener guards at
// twice the grant's session limit: the relay counts and refuses sessions over the limit, the listener only stops a
// flood beyond it and says so.
func TestManagedDatabaseHostListenerCarriesConcurrentConnectionsUpToTwiceTheGrantLimit(t *testing.T) {
	h := newListenerHarness(t)
	status := h.reconcile(h.assignment(testListenerBindingA, 3, 64))[testListenerBindingA]
	if status.State != "ready" {
		t.Fatalf("listener status %+v", status)
	}
	connections := make([]net.Conn, 0, 128)
	for range 40 {
		connections = append(connections, h.dial())
	}
	h.waitOpened(40)
	for _, opened := range h.openedBindings() {
		if opened != (openedBinding{bindingID: testListenerBindingA, generation: 3}) {
			t.Fatalf("connection opened as %+v", opened)
		}
	}
	for range 88 {
		connections = append(connections, h.dial())
	}
	h.waitOpened(88)
	requireOpen(t, connections...)
	if lines := h.log.lines("connection rejected"); len(lines) != 0 {
		t.Fatalf("connections within the guard were rejected: %v", lines)
	}

	requireClosed(t, h.dial())
	lines := h.log.lines("level=WARN", "managed link connection rejected", "binding_id="+testListenerBindingA, "reason="+linkRejectedListenerLimit, "limit=128")
	if len(lines) != 1 {
		t.Fatalf("listener limit rejection not logged once: %q", h.log.lines("rejected"))
	}
	// A burst over the guard is one line per interval, not one per connection.
	requireClosed(t, h.dial())
	if lines := h.log.lines("connection rejected"); len(lines) != 1 {
		t.Fatalf("repeated rejection logged again: %v", lines)
	}
}

// The Gateway update re-signs the grant with the new session limit (16 to 64). The running listener takes it without
// closing its connections.
func TestManagedDatabaseHostListenerTakesANewGrantLimitInPlace(t *testing.T) {
	h := newListenerHarness(t)
	h.reconcile(h.assignment(testListenerBindingA, 3, 1))
	listener := h.listener(testListenerBindingA)
	held := []net.Conn{h.dial(), h.dial()}
	h.waitOpened(2)
	requireClosed(t, h.dial())

	status := h.reconcile(h.assignment(testListenerBindingA, 3, 4))[testListenerBindingA]
	if status.State != "ready" || h.listener(testListenerBindingA) != listener {
		t.Fatalf("a new limit replaced the listener: %+v", status)
	}
	requireOpen(t, held...)
	for range 6 {
		h.dial()
	}
	h.waitOpened(6)
	requireClosed(t, h.dial())
	if got := listener.currentConfig().maxConnections; got != 8 {
		t.Fatalf("listener limit %d, want 8", got)
	}
}

// A grant without a session limit (an older Gateway) gets the link default.
func TestManagedDatabaseHostListenerDefaultsToTheLinkLimit(t *testing.T) {
	h := newListenerHarness(t)
	h.reconcile(h.assignment(testListenerBindingA, 3, 0))
	if got := h.listener(testListenerBindingA).currentConfig().maxConnections; got != 128 {
		t.Fatalf("listener limit %d, want 128", got)
	}
}

// A Docker API that times out while a sync inspects the network says nothing about the network: the listener and its
// connections stay. A network that is gone closes it.
func TestManagedDatabaseHostListenerSurvivesAFailedNetworkInspect(t *testing.T) {
	h := newListenerHarness(t)
	assignment := h.assignment(testListenerBindingA, 3, 64)
	h.reconcile(assignment)
	listener := h.listener(testListenerBindingA)
	held := h.dial()
	h.waitOpened(1)

	h.setInspectError(context.DeadlineExceeded)
	status := h.reconcile(assignment)[testListenerBindingA]
	if status.State != "error" || !strings.Contains(status.Error, "deadline exceeded") {
		t.Fatalf("failed inspect status %+v", status)
	}
	if h.listener(testListenerBindingA) != listener {
		t.Fatal("a failed inspect replaced the listener")
	}
	requireOpen(t, held)
	// A new limit still applies meanwhile.
	h.reconcile(h.assignment(testListenerBindingA, 3, 16))
	if got := listener.currentConfig().maxConnections; got != 32 {
		t.Fatalf("listener limit %d, want 32", got)
	}

	h.setInspectError(nil)
	if status := h.reconcile(assignment)[testListenerBindingA]; status.State != "ready" || h.listener(testListenerBindingA) != listener {
		t.Fatalf("listener after the Docker API recovered: %+v", status)
	}
	requireOpen(t, held)

	h.setInspectError(errors.New("network " + testListenerNetwork + " not found"))
	if status := h.reconcile(assignment)[testListenerBindingA]; status.State != "error" {
		t.Fatalf("missing network status %+v", status)
	}
	if h.listener(testListenerBindingA) != nil {
		t.Fatal("listener of a removed network kept")
	}
	requireClosed(t, held)
}

// An Availability adopt moves the binding's route to another binding id with the same network, address, sources and
// route generation: the listener serves on as the new binding with its connections. A new route generation is
// Gateway's request to replace the listener.
func TestManagedDatabaseHostListenerMovesToTheAdoptingBinding(t *testing.T) {
	h := newListenerHarness(t)
	h.reconcile(h.assignment(testListenerBindingA, 3, 64))
	listener := h.listener(testListenerBindingA)
	held := h.dial()
	h.waitOpened(1)

	statuses := h.reconcile(h.assignment(testListenerBindingB, 3, 64))
	if statuses[testListenerBindingB].State != "ready" || h.listener(testListenerBindingB) != listener || h.listener(testListenerBindingA) != nil {
		t.Fatalf("adopt did not move the listener: %+v", statuses)
	}
	requireOpen(t, held)
	h.dial()
	h.waitOpened(1)
	if opened := h.openedBindings(); opened[len(opened)-1] != (openedBinding{bindingID: testListenerBindingB, generation: 3}) {
		t.Fatalf("new connection opened as %+v", opened[len(opened)-1])
	}

	statuses = h.reconcile(h.assignment(testListenerBindingA, 4, 64))
	if statuses[testListenerBindingA].State != "ready" || h.listener(testListenerBindingA) == listener {
		t.Fatalf("a new route generation kept the listener: %+v", statuses)
	}
	requireClosed(t, held)
}

// Rejections are logged per link and reason once per interval, with the count in between.
func TestLinkRejectionLogIsRateLimited(t *testing.T) {
	logger, output := newTestLogger()
	now := time.Unix(1_000, 0)
	rejections := linkRejectionLog{now: func() time.Time { return now }}
	for range 3 {
		rejections.rejected(logger, linkKindManagedDatabaseBinding, testListenerBindingA, linkRejectedRelayCapacity)
	}
	rejections.rejected(logger, linkKindManagedDatabaseBinding, testListenerBindingB, linkRejectedRelayCapacity)
	rejections.rejected(logger, linkKindManagedDatabaseBinding, testListenerBindingA, linkRejectedListenerLimit)
	if lines := output.lines("connection rejected"); len(lines) != 3 {
		t.Fatalf("logged %d lines, want one per link and reason: %v", len(lines), lines)
	}
	now = now.Add(linkRejectionLogInterval)
	rejections.rejected(logger, linkKindManagedDatabaseBinding, testListenerBindingA, linkRejectedRelayCapacity)
	if lines := output.lines("binding_id="+testListenerBindingA, "reason="+linkRejectedRelayCapacity, "rejected_since_last_log=2"); len(lines) != 1 {
		t.Fatalf("summary line missing: %v", output.lines("connection rejected"))
	}
}
