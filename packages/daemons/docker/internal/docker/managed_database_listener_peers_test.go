package docker

import (
	"context"
	"net/netip"
	"testing"
	"time"

	"github.com/moby/moby/api/types/events"
)

func (h *listenerHarness) setDockerFrozen(frozen bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.inspectErr, h.containerErr = nil, nil
	if frozen {
		h.inspectErr, h.containerErr = context.DeadlineExceeded, context.DeadlineExceeded
	}
}

func (h *listenerHarness) dockerCalls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.networkInspects + h.containerInspects
}

// waitPeerKnown waits until the address book names the harness peer (the reconcile learns it in the background).
func (h *listenerHarness) waitPeerKnown() {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, known := h.manager.peers.lookup("network-1", netip.MustParseAddr("127.0.0.1")); known {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("the listener did not learn its peer")
}

// Stand run X1 (HA-05c): with dockerd frozen every new link connection was refused while the workload, its held
// connections and its HTTP were fine. A workload the listener already knows connects without dockerd.
func TestManagedDatabaseHostListenerAuthorisesAKnownPeerWithoutDockerd(t *testing.T) {
	h := newListenerHarness(t)
	h.manager.peers.streamOpened()
	if status := h.reconcile(h.assignment(testListenerBindingA, 3, 64))[testListenerBindingA]; status.State != "ready" {
		t.Fatalf("listener status %+v", status)
	}
	h.waitPeerKnown()

	h.setDockerFrozen(true)
	calls := h.dockerCalls()
	for range 3 {
		h.dial()
	}
	h.waitOpened(3)
	if got := h.dockerCalls(); got != calls {
		t.Fatalf("known peer cost %d dockerd calls", got-calls)
	}
	if lines := h.log.lines("connection rejected"); len(lines) != 0 {
		t.Fatalf("known peer rejected: %v", lines)
	}
}

// A container that died may leave its address to another container: the listener asks dockerd again, and refuses the
// connection when dockerd does not answer or names a container the binding does not allow.
func TestManagedDatabaseHostListenerRejectsAStaleAddress(t *testing.T) {
	h := newListenerHarness(t)
	h.manager.peers.streamOpened()
	h.reconcile(h.assignment(testListenerBindingA, 3, 64))
	h.dial()
	h.waitOpened(1)

	h.manager.peers.apply(events.Message{Type: events.ContainerEventType, Action: events.ActionDie, Actor: events.Actor{ID: "container-1"}})
	h.setDockerFrozen(true)
	requireClosed(t, h.dial())
	if lines := h.log.lines("connection rejected", "reason="+linkRejectedNetworkUnverified); len(lines) != 1 {
		t.Fatalf("stale address not refused while dockerd is frozen: %v", h.log.lines("rejected"))
	}

	// dockerd answers: the address now belongs to a container the binding does not allow.
	h.mu.Lock()
	h.peerID, h.peerName, h.peerLabels = "container-2", "/intruder", map[string]string{}
	h.mu.Unlock()
	h.setDockerFrozen(false)
	requireClosed(t, h.dial())
	if lines := h.log.lines("connection rejected", "reason="+linkRejectedSourceNotAllowed, "container=intruder"); len(lines) != 1 {
		t.Fatalf("reused address not refused: %v", h.log.lines("rejected"))
	}
	if opened := len(h.openedBindings()); opened != 1 {
		t.Fatalf("%d connections reached the binding, want 1", opened)
	}
}

// Every event that can hand an address to another container drops what it may concern; an answer dockerd gave
// while such an event came in, or while no event stream was open, is not kept.
func TestListenerPeersForgetWhatDockerEventsMayChange(t *testing.T) {
	addressA, addressB := netip.MustParseAddr("172.18.0.2"), netip.MustParseAddr("172.18.0.3")
	peerA, peerB := listenerPeer{containerID: "a", name: "app-a"}, listenerPeer{containerID: "b", name: "app-b"}
	var peers listenerPeers
	if peers.store("net-1", addressA, peerA, peers.begin()) {
		t.Fatal("stored without an open event stream")
	}
	peers.streamOpened()
	fill := func() {
		t.Helper()
		if !peers.store("net-1", addressA, peerA, peers.begin()) || !peers.store("net-1", addressB, peerB, peers.begin()) ||
			!peers.store("net-2", addressA, peerA, peers.begin()) {
			t.Fatal("store refused")
		}
	}
	known := func(networkID string, address netip.Addr) bool {
		_, ok := peers.lookup(networkID, address)
		return ok
	}
	cases := []struct {
		name    string
		message events.Message
		gone    [][2]any
		kept    [][2]any
	}{
		{"container dies", events.Message{Type: events.ContainerEventType, Action: events.ActionDie, Actor: events.Actor{ID: "a"}},
			[][2]any{{"net-1", addressA}, {"net-2", addressA}}, [][2]any{{"net-1", addressB}}},
		{"container renamed", events.Message{Type: events.ContainerEventType, Action: events.ActionRename, Actor: events.Actor{ID: "b"}},
			[][2]any{{"net-1", addressB}}, [][2]any{{"net-1", addressA}, {"net-2", addressA}}},
		{"disconnect", events.Message{Type: events.NetworkEventType, Action: events.ActionDisconnect, Actor: events.Actor{ID: "net-1", Attributes: map[string]string{"container": "a"}}},
			[][2]any{{"net-1", addressA}}, [][2]any{{"net-1", addressB}, {"net-2", addressA}}},
		{"another container connects", events.Message{Type: events.NetworkEventType, Action: events.ActionConnect, Actor: events.Actor{ID: "net-1", Attributes: map[string]string{"container": "b"}}},
			[][2]any{{"net-1", addressA}}, [][2]any{{"net-1", addressB}, {"net-2", addressA}}},
		{"network removed", events.Message{Type: events.NetworkEventType, Action: events.ActionDestroy, Actor: events.Actor{ID: "net-1"}},
			[][2]any{{"net-1", addressA}, {"net-1", addressB}}, [][2]any{{"net-2", addressA}}},
	}
	for _, tc := range cases {
		fill()
		peers.apply(tc.message)
		for _, entry := range tc.gone {
			if known(entry[0].(string), entry[1].(netip.Addr)) {
				t.Fatalf("%s: %v %v still known", tc.name, entry[0], entry[1])
			}
		}
		for _, entry := range tc.kept {
			if !known(entry[0].(string), entry[1].(netip.Addr)) {
				t.Fatalf("%s: %v %v forgotten", tc.name, entry[0], entry[1])
			}
		}
	}

	generation := peers.begin()
	peers.apply(events.Message{Type: events.ContainerEventType, Action: events.ActionDestroy, Actor: events.Actor{ID: "c"}})
	if peers.store("net-1", addressA, peerA, generation) {
		t.Fatal("an answer that crossed an event was stored")
	}
	fill()
	peers.streamClosed()
	if known("net-1", addressB) {
		t.Fatal("entries trusted without an event stream")
	}
	peers.streamOpened()
	if known("net-1", addressB) {
		t.Fatal("entries from before the stream was lost came back")
	}
}
