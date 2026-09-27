package relaybridge

import (
	"reflect"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func placed(id, role string, endpointRTT time.Duration) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{
		RelayInstanceId: id,
		Topology:        &pb.RelayCandidateTopology{Role: role, EndpointRttMicros: uint32(endpointRTT.Microseconds())},
	}
}

func ids(candidates []*pb.RelayDataCandidate) []string {
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate.GetRelayInstanceId())
	}
	return result
}

func rtts(values map[string]time.Duration) func(string) (time.Duration, bool) {
	return func(id string) (time.Duration, bool) {
		value, ok := values[id]
		return value, ok
	}
}

func allAvailable(active map[string]int64, idList ...string) map[string]TransportLoad {
	result := map[string]TransportLoad{}
	for _, id := range idList {
		result[id] = TransportLoad{Available: true, Active: active[id]}
	}
	return result
}

// An old Gateway sends no roles: the order stays availability, load, then
// round-robin, whatever this node measured.
func TestOrderCandidatesWithoutTopologyKeepsLoadAndRoundRobin(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{{RelayInstanceId: "a"}, {RelayInstanceId: "b"}, {RelayInstanceId: "c"}}
	measured := rtts(map[string]time.Duration{"a": 80 * time.Millisecond, "b": time.Millisecond, "c": 40 * time.Millisecond})
	transports := map[string]TransportLoad{"a": {Available: true, Active: 1}, "b": {Available: true, Active: 3}}
	if got := ids(OrderCandidates(candidates, transports, 0, measured)); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("order = %v", got)
	}
	transports["b"] = TransportLoad{Available: true, Active: 1}
	if got := ids(OrderCandidates(candidates, transports, 1, measured)); !reflect.DeepEqual(got, []string{"b", "a", "c"}) {
		t.Fatalf("round-robin order = %v", got)
	}
}

func TestOrderCandidatesTriesPrimariesBeforeStandbys(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed("standby-near", RoleStandby, time.Millisecond),
		placed("primary", RolePrimary, 30*time.Millisecond),
	}
	measured := rtts(map[string]time.Duration{"standby-near": time.Millisecond, "primary": 30 * time.Millisecond})
	got := ids(OrderCandidates(candidates, allAvailable(nil, "standby-near", "primary"), 0, measured))
	if !reflect.DeepEqual(got, []string{"primary", "standby-near"}) {
		t.Fatalf("order = %v", got)
	}
	// A standby is used first only when no primary has a transport.
	transports := map[string]TransportLoad{"standby-near": {Available: true}}
	got = ids(OrderCandidates(candidates, transports, 0, measured))
	if !reflect.DeepEqual(got, []string{"standby-near", "primary"}) {
		t.Fatalf("order without a primary transport = %v", got)
	}
}

func TestOrderCandidatesPrefersTheNearerPathWithinARole(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed("far", RolePrimary, 20*time.Millisecond),
		placed("near", RolePrimary, time.Millisecond),
	}
	measured := rtts(map[string]time.Duration{"far": 20 * time.Millisecond, "near": time.Millisecond})
	// The nearer relay wins even with more tunnels: load only splits equally near relays.
	got := ids(OrderCandidates(candidates, allAvailable(map[string]int64{"near": 9}, "far", "near"), 0, measured))
	if !reflect.DeepEqual(got, []string{"near", "far"}) {
		t.Fatalf("order = %v", got)
	}
}

func TestOrderCandidatesSharesLoadBetweenEquallyNearRelays(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed("a", RolePrimary, 500*time.Microsecond),
		placed("b", RolePrimary, 900*time.Microsecond),
		placed("remote", RolePrimary, 40*time.Millisecond),
	}
	measured := rtts(map[string]time.Duration{"a": 400 * time.Microsecond, "b": 1200 * time.Microsecond, "remote": 40 * time.Millisecond})
	got := ids(OrderCandidates(candidates, allAvailable(map[string]int64{"a": 4, "b": 1}, "a", "b", "remote"), 0, measured))
	if !reflect.DeepEqual(got, []string{"b", "a", "remote"}) {
		t.Fatalf("order = %v", got)
	}
}

func TestOrderCandidatesPutsUnmeasuredRelaysAfterMeasuredOnes(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed("unmeasured", RolePrimary, time.Millisecond),
		placed("endpoint-unknown", RolePrimary, 0),
		placed("measured", RolePrimary, 10*time.Millisecond),
	}
	measured := rtts(map[string]time.Duration{"measured": 10 * time.Millisecond, "endpoint-unknown": time.Millisecond})
	got := ids(OrderCandidates(candidates, allAvailable(nil, "unmeasured", "endpoint-unknown", "measured"), 0, measured))
	if got[0] != "measured" {
		t.Fatalf("order = %v", got)
	}
}
