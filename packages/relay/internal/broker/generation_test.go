package broker

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
)

// applyLeaseEndpointGeneration applies the fixture's policy with lease-ep at generation, through the broker as a
// policy push does.
func (f *leaseFixture) applyLeaseEndpointGeneration(t *testing.T, revision, generation uint64) {
	t.Helper()
	endpoint := func(id string, generation uint64, policy string) *relayv1.EndpointPolicy {
		return &relayv1.EndpointPolicy{EndpointId: id, Generation: generation, SubjectKind: "node", SubjectId: "node-a", CertificateSha256: f.fingerprint, LeasePolicyId: policy}
	}
	route := func(id, sourceKind, sourceID, target, policy string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: sourceKind, SourceId: sourceID, SourceCertificateSha256: f.fingerprint, TargetEndpointId: target, LeasePolicyId: policy}
	}
	if _, _, err := f.broker.ApplySnapshot(&relayv1.ApplySnapshotRequest{
		Revision: revision, GatewayInstanceId: "gateway-1",
		PublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: f.grantKey.Public().(ed25519.PublicKey)}},
		Endpoints:  []*relayv1.EndpointPolicy{endpoint("lease-ep", generation, "policy-1"), endpoint("plain-ep", 1, "")},
		Routes: []*relayv1.RoutePolicy{
			route("db-route", "node", "node-a", "plain-ep", "policy-1"),
			route("proxy-route", "nginx", "nginx-1", "lease-ep", ""),
			route("plain-route", "nginx", "nginx-1", "plain-ep", ""),
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func (f *leaseFixture) registerAt(t *testing.T, generation uint64) (*registerStream, chan error, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(f.ctx)
	stream := &registerStream{ctx: ctx, sent: make(chan *relayv1.EndpointControl, 8), more: make(chan *relayv1.EndpointControl, 4), first: &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{
		Grant: f.endpointGrantAt(t, "lease-ep", generation), State: relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING,
	}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.RegisterEndpoint(stream) }()
	t.Cleanup(cancel)
	return stream, result, cancel
}

func (f *leaseFixture) renewAt(stream *registerStream, t *testing.T, generation uint64) {
	t.Helper()
	stream.more <- &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{
		Grant: f.endpointGrantAt(t, "lease-ep", generation), State: relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING,
	}}}
}

func (f *leaseFixture) leaseRegistration() *endpointRegistration {
	f.broker.mu.Lock()
	defer f.broker.mu.Unlock()
	return f.broker.endpoints[policyAssignmentKey("lease-ep", 0)]
}

func expectQuiet(t *testing.T, stream *registerStream, result chan error, what string) {
	t.Helper()
	select {
	case message := <-stream.sent:
		t.Fatalf("%s: unexpected %v", what, message)
	case err := <-result:
		t.Fatalf("%s: registration ended: %v", what, err)
	case <-time.After(200 * time.Millisecond):
	}
}

func expectIncoming(t *testing.T, stream *registerStream, opened chan error) {
	t.Helper()
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("got %v instead of an incoming tunnel", message)
		}
	case err := <-opened:
		t.Fatalf("tunnel refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no incoming tunnel")
	}
}

// E's B-18 leftover: an endpoint generation bump (the target's certificate rotated, or its node changed) no longer
// evicts the serving registration before the daemon has the new grant. The previous generation keeps serving, its
// tunnels too, and the new grant renews it in place.
func TestGenerationBumpKeepsServingUntilTheNewGrantRenewsInPlace(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.registerAt(t, 1)
	waitRegistered(t, stream, result)
	session := &activeTunnel{routeID: "proxy-route", routeGeneration: 1, endpointID: "lease-ep", endpointGeneration: 1, registration: f.leaseRegistration(), stop: make(chan struct{})}
	f.broker.mu.Lock()
	f.broker.active["live"] = session
	f.broker.mu.Unlock()

	f.applyLeaseEndpointGeneration(t, 2, 2)

	expectQuiet(t, stream, result, "after the bump")
	select {
	case <-session.stop:
		t.Fatal("a live tunnel was cut by the generation bump")
	default:
	}
	openCtx, cancelOpen := context.WithCancel(f.ctx)
	defer cancelOpen()
	expectIncoming(t, stream, f.openProxyTunnel(t, openCtx))
	cancelOpen()

	f.renewAt(stream, t, 2)
	waitRegistered(t, stream, result)
	registration := f.leaseRegistration()
	if registration == nil || registration.generation != 2 || registration.supersededAt.Load() != 0 {
		t.Fatalf("registration after the new grant = %+v", registration)
	}
}

// The daemon may get its new grant before the relay gets the policy. The renewal waits on the stream and applies the
// moment the policy arrives; a fresh registration ahead of the policy waits for it the same way.
func TestGrantAheadOfThePolicyAppliesWhenThePolicyArrives(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.registerAt(t, 1)
	waitRegistered(t, stream, result)
	f.renewAt(stream, t, 2)
	expectQuiet(t, stream, result, "renewal ahead of the policy")

	fresh, freshResult, _ := f.registerAt(t, 2)
	expectQuiet(t, fresh, freshResult, "registration ahead of the policy")

	started := time.Now()
	f.applyLeaseEndpointGeneration(t, 2, 2)
	waitRegistered(t, fresh, freshResult)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("the waiting registration passed %s after the policy", elapsed)
	}
	// The fresh registration took the endpoint over; the old stream ends.
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("the superseded stream ended without an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the superseded stream was not retired")
	}

	// A grant behind the policy is refused at once: only a newer policy can make it valid, and none will.
	stale, staleResult, _ := f.registerAt(t, 1)
	started = time.Now()
	waitEnded(t, staleResult, codes.PermissionDenied, "does not match policy")
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("a stale grant was refused after %s", elapsed)
	}
	_ = stale
}

// A new generation registered over another connection (the daemon's new certificate, or the new target node) retires
// the previous registration; the previous registration's live tunnels keep running over its connection.
func TestNewGenerationRegistrationRetiresThePreviousWithoutCuttingItsTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	old, oldResult, _ := f.registerAt(t, 1)
	waitRegistered(t, old, oldResult)
	session := &activeTunnel{routeID: "proxy-route", routeGeneration: 1, endpointID: "lease-ep", endpointGeneration: 1, registration: f.leaseRegistration(), stop: make(chan struct{})}
	f.broker.mu.Lock()
	f.broker.active["live"] = session
	f.broker.mu.Unlock()
	f.applyLeaseEndpointGeneration(t, 2, 2)

	next, nextResult, _ := f.registerAt(t, 2)
	waitRegistered(t, next, nextResult)
	waitEnded(t, oldResult, codes.Aborted, "")
	select {
	case <-session.stop:
		t.Fatal("the previous generation's live tunnel was cut")
	default:
	}
	openCtx, cancelOpen := context.WithCancel(f.ctx)
	defer cancelOpen()
	expectIncoming(t, next, f.openProxyTunnel(t, openCtx))
}
