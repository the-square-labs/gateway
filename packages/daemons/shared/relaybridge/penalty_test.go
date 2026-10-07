package relaybridge

import (
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// A relay that failed a route is tried after the other relay of its role until
// the penalty runs out or it succeeds; another route is not affected.
func TestPenalizedRelayComesAfterTheOthersOfItsRole(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	candidates := []*pb.RelayDataCandidate{{RelayInstanceId: "relay-a"}, {RelayInstanceId: "relay-b"}}
	order := func(route string) string {
		transports := map[string]TransportLoad{}
		for _, candidate := range candidates {
			id := candidate.GetRelayInstanceId()
			transports[id] = TransportLoad{Available: true, Penalized: penalties.Penalized(id, route)}
		}
		return OrderCandidates(candidates, transports, 0, nil)[0].GetRelayInstanceId()
	}
	if first := order("route-1"); first != "relay-a" {
		t.Fatalf("first relay %s before any failure", first)
	}
	penalties.Failed("relay-a", "route-1")
	if first := order("route-1"); first != "relay-b" {
		t.Fatalf("penalized relay still first: %s", first)
	}
	if first := order("route-2"); first != "relay-a" {
		t.Fatalf("another route followed the penalty: %s", first)
	}
	now = now.Add(penaltyInitial + time.Second)
	if first := order("route-1"); first != "relay-a" {
		t.Fatalf("penalty did not run out: %s", first)
	}
	// A failure right after the penalty ran out doubles it.
	penalties.Failed("relay-a", "route-1")
	now = now.Add(penaltyInitial + time.Second)
	if !penalties.Penalized("relay-a", "route-1") {
		t.Fatal("a repeated failure was not penalized longer")
	}
	penalties.Succeeded("relay-a", "route-1")
	if penalties.Penalized("relay-a", "route-1") {
		t.Fatal("a success did not clear the penalty")
	}
}
