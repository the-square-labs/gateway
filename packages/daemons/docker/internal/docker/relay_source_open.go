package docker

import (
	"errors"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
)

var (
	// relaySourceOpenTimeout bounds one relay's answer to a source tunnel open. The relay admits the tunnel once the
	// target daemon accepted it; a relay that took the open and gets no answer (the target daemon wedged, a lane half
	// dead, a registration of a host that went away) held it for its own accept timeout of 30 s, one candidate after
	// the other.
	relaySourceOpenTimeout = relayresume.OpenTimeout
	// relaySourceOpenBudget bounds the opens of one connection across all its relays. It stays below the
	// connector's dial timeout (10 s): a connection the connector already gave up on no longer holds its link slot
	// and a relay session.
	relaySourceOpenBudget = 8 * time.Second
)

// openRelaySource opens a source tunnel for assignment on the first of its relay candidates (in load and latency
// order) that accepts it within relaySourceOpenBudget. When none does, the error is a capacity refusal if any relay
// gave one (the relay's own reason), else the last refusal. Right after this process started, a connection that
// finds no relay lane waits for the first lanes (relayLaneStartupWait): the link sockets the previous process handed
// over are served before the lanes are up.
func (p *DockerPlugin) openRelaySource(assignment *pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	for {
		tunnel, err := p.openRelaySourceOnce(assignment, time.Now().Add(relaySourceOpenBudget))
		if err == nil || !errors.Is(err, errRelayLaneUnavailable) || !p.waitForRelayLanes() {
			return tunnel, err
		}
	}
}

// openRelaySourceOnce tries every candidate once, each within relaySourceOpenTimeout and all before deadline.
func (p *DockerPlugin) openRelaySourceOnce(assignment *pb.RelayGrantAssignment, deadline time.Time) (*relaySourceTunnel, error) {
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.GetGrant()}}
	}
	refusal := errRelayLaneUnavailable
	for _, candidate := range p.orderRelayCandidates(candidates) {
		router := p.relayRouter(candidate.GetRelayInstanceId())
		if router == nil {
			continue
		}
		timeout := min(relaySourceOpenTimeout, time.Until(deadline))
		if timeout <= 0 {
			break
		}
		tunnel, err := router.openSourceWithin(candidate.GetGrant(), timeout)
		if err == nil {
			p.makeResumable(tunnel, assignment)
			return tunnel, nil
		}
		if relayRefusalReason(refusal) != linkRejectedRelayCapacity {
			refusal = err
		}
	}
	return nil, refusal
}

func (p *DockerPlugin) orderRelayCandidates(candidates []*pb.RelayDataCandidate) []*pb.RelayDataCandidate {
	if len(candidates) < 2 {
		return append([]*pb.RelayDataCandidate(nil), candidates...)
	}
	p.relayTunnelMu.Lock()
	transports := make(map[string]relaybridge.TransportLoad, len(p.relayTunnels))
	for targetID, router := range p.relayTunnels {
		transports[targetID] = relaybridge.TransportLoad{Available: router.connected(), Active: router.active.Load()}
	}
	rotation := p.relaySelection
	p.relaySelection++
	p.relayTunnelMu.Unlock()
	return relaybridge.OrderCandidates(candidates, transports, rotation, relaybridge.Latency.RTT)
}

func (p *DockerPlugin) relayRouter(targetID string) *relayTunnelRouter {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	return p.relayTunnels[targetID]
}
