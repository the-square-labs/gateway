package supervisor

import (
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

func TestForwardAvailabilityLeaseKeepsTheGatewayReportShape(t *testing.T) {
	if forwardAvailabilityLease(nil, nil) != nil {
		t.Fatal("a worker without lease coordination produced a report")
	}
	report := &relayv1.AvailabilityLeaseReport{
		MemberId: "relay-1", IdentityPublicKey: []byte{1, 2}, Incarnation: 7, Epoch: 3,
		TrustedPolicyKeyIds: []string{"k1"}, AcceptorAbstaining: true,
		Manifests: []*relayv1.AvailabilityLeaseManifestAck{{PolicyId: "p1", ManifestVersion: 4, Closed: true}},
		Acceptor: []*relayv1.AvailabilityLeaseKeyView{{
			PolicyId: "p1", Slot: 1, State: "held", HolderId: "node-a", ReservedFor: "node-b",
			Promised:  &relayv1.AvailabilityLeaseBallot{Round: 5, Incarnation: 6, ProposerId: "node-a"},
			Committed: &relayv1.AvailabilityLeaseBallot{Round: 5, Incarnation: 6, ProposerId: "node-a"},
			Epoch:     3, ManifestVersion: 4, GateOpen: true, GateReason: "relay only", GateRemainingMs: 1000,
		}},
		Voter: true, ConnectedMemberIds: []string{"node-a"},
	}
	forwarded := forwardAvailabilityLease(report, nil)
	if forwarded.GetMemberId() != "relay-1" || string(forwarded.GetIdentityPublicKey()) != "\x01\x02" || forwarded.GetIncarnation() != 7 ||
		forwarded.GetEpoch() != 3 || len(forwarded.GetTrustedPolicyKeyIds()) != 1 || !forwarded.GetAcceptorAbstaining() {
		t.Fatalf("forwarded report = %v", forwarded)
	}
	if manifests := forwarded.GetManifests(); len(manifests) != 1 || manifests[0].GetManifestVersion() != 4 || !manifests[0].GetClosed() {
		t.Fatalf("forwarded manifests = %v", manifests)
	}
	acceptor := forwarded.GetAcceptor()
	if len(acceptor) != 1 || acceptor[0].GetSlot() != 1 || acceptor[0].GetState() != "held" || acceptor[0].GetHolderId() != "node-a" ||
		acceptor[0].GetReservedFor() != "node-b" || acceptor[0].GetCommitted().GetRound() != 5 || acceptor[0].GetPromised().GetProposerId() != "node-a" ||
		acceptor[0].GetEpoch() != 3 || acceptor[0].GetManifestVersion() != 4 || !acceptor[0].GetGateOpen() {
		t.Fatalf("forwarded acceptor view = %v", acceptor)
	}
}
