package lease

import (
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/protobuf/proto"
)

func acquire(t *testing.T, h *harness, id string) {
	t.Helper()
	if !h.stepUntil(90*time.Second, func() bool { return h.holding(id) && h.relay.Admit(policyID, id).Open }) {
		t.Fatalf("%s did not acquire with an open relay gate (admission %+v)", id, h.relay.Admit(policyID, id))
	}
}

func TestGateOpensOnlyForCommittedHolderAndClosesWhenStale(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if other := h.relay.Admit(policyID, "d2"); !other.LeaseMode || other.Open {
		t.Fatalf("non-holder admission = %+v", other)
	}
	report := h.relay.Report()
	if len(report.GetAcceptor()) != 1 || !report.GetAcceptor()[0].GetGateOpen() || report.GetAcceptor()[0].GetGateHolderId() != "d1" || report.GetAcceptor()[0].GetHolderId() != "d1" {
		t.Fatalf("acceptor view = %v", report.GetAcceptor())
	}
	if !report.GetVoter() || report.GetEpoch() != 1 || len(report.GetManifests()) != 1 || len(report.GetTrustedPolicyKeyIds()) != 1 {
		t.Fatalf("report = %v", report)
	}

	// The holder goes silent: the gate closes by itself GateWindow after the
	// relay's last promise, without any message.
	h.down["d1"] = true
	remaining := h.relay.Admit(policyID, "d1").Remaining
	if remaining <= 0 || remaining > availabilitylease.GateWindow {
		t.Fatalf("remaining gate time = %s", remaining)
	}
	h.step(remaining - 200*time.Millisecond)
	if !h.relay.Admit(policyID, "d1").Open {
		t.Fatal("gate closed before its window ended")
	}
	h.step(300 * time.Millisecond)
	if admission := h.relay.Admit(policyID, "d1"); admission.Open || !admission.LeaseMode {
		t.Fatalf("stale gate admission = %+v", admission)
	}
	acquire(t, h, "d2")
	if h.relay.Admit(policyID, "d1").Open {
		t.Fatal("old holder admitted after the takeover")
	}
}

func TestGateMovesOnHandoffAndCloseForSupersededHolder(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if err := h.daemons["d1"].Release(testKey, "d2"); err != nil {
		t.Fatal(err)
	}
	h.step(100 * time.Millisecond)
	if admission := h.relay.Admit(policyID, "d1"); admission.Open {
		t.Fatalf("relinquished holder still admitted: %+v", admission)
	}
	acquire(t, h, "d2")
	if admission := h.relay.Admit(policyID, "d1"); admission.Open {
		t.Fatalf("superseded holder admitted: %+v", admission)
	}
}

func TestSuspendClosesGatesUntilFreshPromise(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	// A VM freeze: the lease clock stood still, the wall clock moved on.
	h.wallSkew += 20 * time.Second
	admission := h.relay.Admit(policyID, "d1")
	if admission.Open || !strings.Contains(admission.Reason, "suspend") {
		t.Fatalf("admission after suspend = %+v", admission)
	}
	report := h.relay.Report()
	if report.GetLastSuspendDurationMs() < 19_000 || report.GetAcceptor()[0].GetGateOpen() {
		t.Fatalf("report after suspend = %v", report)
	}
	if !h.stepUntil(availabilitylease.RenewInterval+2*time.Second, func() bool { return h.relay.Admit(policyID, "d1").Open }) {
		t.Fatalf("gate did not reopen on a fresh promise: %+v", h.relay.Admit(policyID, "d1"))
	}
}

func TestNonVotingRelayGatesFromShadowAccepts(t *testing.T) {
	h := newHarness(t, false)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if h.relay.Report().GetVoter() {
		t.Fatal("non-voting relay reports itself as a voter")
	}
	promises := relayPromises(t, h.relayFrames["d1"])
	if len(promises) == 0 {
		t.Fatal("relay sent no promises")
	}
	for _, promise := range promises {
		if !promise.GetShadow() {
			t.Fatal("non-voting relay sent a counted promise")
		}
	}
}

func TestClosedManifestUsesLegacyAdmissionAndUnknownPolicyStaysClosed(t *testing.T) {
	h := newHarness(t, true)
	if admission := h.relay.Admit("unknown-policy", "d1"); !admission.LeaseMode || admission.Open {
		t.Fatalf("unknown policy admission = %+v", admission)
	}
	closed := h.signManifest([]string{"d1", "d2"}, true)
	h.relay.ApplyPolicy(&policy.Snapshot{LeaseBlocks: []*relayv1.LeaseSignedBlock{h.config, closed}})
	if admission := h.relay.Admit(policyID, "d2"); admission.LeaseMode {
		t.Fatalf("lease-closed policy admission = %+v", admission)
	}
	if acks := h.relay.Report().GetManifests(); len(acks) != 1 || !acks[0].GetClosed() || acks[0].GetManifestVersion() != 2 {
		t.Fatalf("manifest acks = %v", acks)
	}
}

func relayPromises(t *testing.T, frames []*relayv1.CoordinationFrame) []*relayv1.LeasePromise {
	t.Helper()
	var promises []*relayv1.LeasePromise
	for _, frame := range frames {
		batch := &relayv1.LeaseBatch{}
		if err := proto.Unmarshal(frame.GetPayload(), batch); err != nil {
			t.Fatal(err)
		}
		for _, item := range batch.GetItems() {
			if promise := item.GetPromise(); promise != nil {
				promises = append(promises, promise)
			}
		}
	}
	return promises
}
