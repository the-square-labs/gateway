package daemon

import (
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestRelayGrantStoreSignalsOnlyLaneOrTargetChanges(t *testing.T) {
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 1, DataLanes: 4, ReadChunkBytes: 32 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, true)

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 2, DataLanes: 4, ReadChunkBytes: 64 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, false)

	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 3, DataLanes: 6, ReadChunkBytes: 64 * 1024}); err != nil {
		t.Fatal(err)
	}
	assertRelayRuntimeSignal(t, store.changed, true)
}

func assertRelayRuntimeSignal(t *testing.T, changed <-chan struct{}, want bool) {
	t.Helper()
	select {
	case <-changed:
		if !want {
			t.Fatal("unexpected relay runtime change signal")
		}
	default:
		if want {
			t.Fatal("expected relay runtime change signal")
		}
	}
}

func TestOrderRelayCandidatesBalancesEqualLoadAndPrefersLeastActive(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{{RelayInstanceId: "relay-a"}, {RelayInstanceId: "relay-b"}}
	firstTunnel := &nginxRelayTunnel{targetID: "relay-a"}
	secondTunnel := &nginxRelayTunnel{targetID: "relay-b"}
	plugin := &NginxPlugin{relayTunnels: []*nginxRelayTunnel{firstTunnel, secondTunnel}}

	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-a" {
		t.Fatalf("first candidate = %q, want relay-a", got)
	}
	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-b" {
		t.Fatalf("round-robin candidate = %q, want relay-b", got)
	}
	firstTunnel.active.Store(2)
	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-b" {
		t.Fatalf("least-active candidate = %q, want relay-b", got)
	}
}
