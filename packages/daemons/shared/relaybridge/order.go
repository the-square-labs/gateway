package relaybridge

import (
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	RolePrimary = "primary"
	RoleStandby = "standby"

	// Relays whose path cost is within this band of the nearest one count as
	// equally near and share connections by load; Gateway uses the same band.
	costBandRatio = 1.2
	costBandFloor = 3 * time.Millisecond
)

// TransportLoad is what the daemon knows about its transport to one relay.
type TransportLoad struct {
	Available bool
	Active    int64
}

// OrderCandidates orders the relays to try for a new source tunnel: relays
// with a transport first, then Gateway's primaries before its standbys, then
// the nearer path (this node's own measured round trip plus the relay's
// round trip to the endpoint), then fewer active tunnels, then round-robin
// from rotation. Candidates without a Gateway role get today's order.
func OrderCandidates(
	candidates []*pb.RelayDataCandidate,
	transports map[string]TransportLoad,
	rotation uint64,
	rtt func(relayInstanceID string) (time.Duration, bool),
) []*pb.RelayDataCandidate {
	ordered := append([]*pb.RelayDataCandidate(nil), candidates...)
	if len(ordered) < 2 {
		return ordered
	}
	start := int(rotation % uint64(len(ordered)))
	rank := make(map[string]int, len(ordered))
	for offset := range ordered {
		rank[ordered[(start+offset)%len(ordered)].GetRelayInstanceId()] = offset
	}
	costs := make(map[string]time.Duration, len(ordered))
	for _, candidate := range ordered {
		if cost, ok := pathCost(candidate, rtt); ok {
			costs[candidate.GetRelayInstanceId()] = cost
		}
	}
	tiers := costTiers(ordered, transports, costs)
	sort.SliceStable(ordered, func(i, j int) bool {
		left, right := ordered[i], ordered[j]
		leftID, rightID := left.GetRelayInstanceId(), right.GetRelayInstanceId()
		if transports[leftID].Available != transports[rightID].Available {
			return transports[leftID].Available
		}
		if roleRank(left) != roleRank(right) {
			return roleRank(left) < roleRank(right)
		}
		if tiers[leftID] != tiers[rightID] {
			return tiers[leftID] < tiers[rightID]
		}
		if tiers[leftID] == tierFar && costs[leftID] != costs[rightID] {
			return costs[leftID] < costs[rightID]
		}
		if transports[leftID].Active != transports[rightID].Active {
			return transports[leftID].Active < transports[rightID].Active
		}
		return rank[leftID] < rank[rightID]
	})
	return ordered
}

const (
	tierNear = iota
	tierFar
	tierUnknown
)

// costTiers puts every relay of a role whose cost is within the band of the
// nearest available relay of that role in one tier, so equally near relays
// share load, and the rest after it by cost. A relay without a known cost
// comes last; with no cost known at all every relay is in one tier.
func costTiers(candidates []*pb.RelayDataCandidate, transports map[string]TransportLoad, costs map[string]time.Duration) map[string]int {
	best := map[int]time.Duration{}
	for _, candidate := range candidates {
		id := candidate.GetRelayInstanceId()
		cost, ok := costs[id]
		if !ok || !transports[id].Available {
			continue
		}
		role := roleRank(candidate)
		if current, seen := best[role]; !seen || cost < current {
			best[role] = cost
		}
	}
	tiers := make(map[string]int, len(candidates))
	for _, candidate := range candidates {
		id := candidate.GetRelayInstanceId()
		cost, ok := costs[id]
		nearest, seen := best[roleRank(candidate)]
		switch {
		case !ok:
			tiers[id] = tierUnknown
		case !seen || cost <= costBand(nearest):
			tiers[id] = tierNear
		default:
			tiers[id] = tierFar
		}
	}
	return tiers
}

func costBand(nearest time.Duration) time.Duration {
	band := time.Duration(float64(nearest) * costBandRatio)
	if floor := nearest + costBandFloor; floor > band {
		return floor
	}
	return band
}

// pathCost is this node's round trip to the relay plus the relay's round trip
// to the endpoint. It is known only when Gateway placed the endpoint by
// latency and reported the endpoint side, and this node measured its side.
func pathCost(candidate *pb.RelayDataCandidate, rtt func(string) (time.Duration, bool)) (time.Duration, bool) {
	topology := candidate.GetTopology()
	if topology.GetRole() == "" || topology.GetEndpointRttMicros() == 0 || rtt == nil {
		return 0, false
	}
	own, ok := rtt(candidate.GetRelayInstanceId())
	if !ok {
		return 0, false
	}
	return own + time.Duration(topology.GetEndpointRttMicros())*time.Microsecond, true
}

// roleRank puts primaries (and candidates Gateway gave no role) before standbys.
func roleRank(candidate *pb.RelayDataCandidate) int {
	if candidate.GetTopology().GetRole() == RoleStandby {
		return 1
	}
	return 0
}
