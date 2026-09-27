package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// fakeLeaseGate admits (policy, subject) pairs from a table.
type fakeLeaseGate struct {
	mu        sync.Mutex
	decisions map[string]LeaseAdmission
}

func (g *fakeLeaseGate) set(policyID, subjectID string, admission LeaseAdmission) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.decisions[policyID+"/"+subjectID] = admission
}

func (g *fakeLeaseGate) Admit(policyID, subjectID string) LeaseAdmission {
	g.mu.Lock()
	defer g.mu.Unlock()
	if admission, ok := g.decisions[policyID+"/"+subjectID]; ok {
		return admission
	}
	return LeaseAdmission{LeaseMode: true, Reason: "not the holder"}
}

func (g *fakeLeaseGate) ApplyPolicy(*policy.Snapshot) {}
func (g *fakeLeaseGate) Coordinate(relayv1.TunnelBroker_CoordinateServer) error {
	return nil
}
func (g *fakeLeaseGate) WatchLeaseGates(*relayv1.LeaseGateWatchRequest, relayv1.TunnelBroker_WatchLeaseGatesServer) error {
	return nil
}

type registerStream struct {
	relayv1.TunnelBroker_RegisterEndpointServer
	ctx   context.Context
	first *relayv1.EndpointControl
	sent  chan *relayv1.EndpointControl
}

func (s *registerStream) Context() context.Context { return s.ctx }
func (s *registerStream) Recv() (*relayv1.EndpointControl, error) {
	if first := s.first; first != nil {
		s.first = nil
		return first, nil
	}
	<-s.ctx.Done()
	return nil, s.ctx.Err()
}
func (s *registerStream) Send(message *relayv1.EndpointControl) error {
	s.sent <- message
	return nil
}
func (s *registerStream) SetHeader(metadata.MD) error  { return nil }
func (s *registerStream) SendHeader(metadata.MD) error { return nil }
func (s *registerStream) SetTrailer(metadata.MD)       {}

type leaseFixture struct {
	broker      *Broker
	gate        *fakeLeaseGate
	grantKey    ed25519.PrivateKey
	ctx         context.Context
	fingerprint string
}

// newLeaseFixture serves node-a with a lease-bound endpoint (lease-ep), a
// plain endpoint (plain-ep), a managed-DB style route whose source is the
// lease-bound placement (db-route), an nginx route to the lease endpoint
// (proxy-route) and a plain nginx route (plain-route).
func newLeaseFixture(t *testing.T) *leaseFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ctx := authenticatedContext("node-a", []byte("node-a-certificate"))
	identity, _ := grpcpeer.FromContext(ctx)
	certificate := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	fingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	endpoint := func(id, leasePolicy string) *relayv1.EndpointPolicy {
		return &relayv1.EndpointPolicy{EndpointId: id, Generation: 1, SubjectKind: "node", SubjectId: "node-a", CertificateSha256: fingerprint, LeasePolicyId: leasePolicy}
	}
	route := func(id, sourceKind, sourceID, target, leasePolicy string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: sourceKind, SourceId: sourceID, SourceCertificateSha256: fingerprint, TargetEndpointId: target, LeasePolicyId: leasePolicy}
	}
	if _, _, err := store.Apply(&relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "gateway-1", PublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: public}},
		Endpoints: []*relayv1.EndpointPolicy{endpoint("lease-ep", "policy-1"), endpoint("plain-ep", "")},
		Routes: []*relayv1.RoutePolicy{
			route("db-route", "node", "node-a", "plain-ep", "policy-1"),
			route("proxy-route", "nginx", "nginx-1", "lease-ep", ""),
			route("plain-route", "nginx", "nginx-1", "plain-ep", ""),
		},
	}); err != nil {
		t.Fatal(err)
	}
	b := New(store)
	gate := &fakeLeaseGate{decisions: map[string]LeaseAdmission{}}
	b.SetLeaseGate(gate)
	return &leaseFixture{broker: b, gate: gate, grantKey: private, ctx: ctx, fingerprint: fingerprint}
}

func (f *leaseFixture) register(t *testing.T, endpointID string) (*registerStream, chan error, context.CancelFunc) {
	t.Helper()
	now := time.Now().Unix()
	payload, err := json.Marshal(grant.Claims{
		SchemaVersion: 1, Audience: grant.Audience, GrantID: "grant-" + endpointID, GatewayInstanceID: "gateway-1", Kind: "endpoint",
		SubjectKind: "node", SubjectID: "node-a", CertificateSHA256: f.fingerprint, EndpointID: endpointID, EndpointGeneration: 1,
		IssuedAt: now - 10, NotBefore: now - 10, ExpiresAt: now + 3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	stream := &registerStream{ctx: ctx, sent: make(chan *relayv1.EndpointControl, 8), first: &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{
		Grant: &relayv1.SignedGrant{KeyId: "grant-key", Payload: payload, Signature: ed25519.Sign(f.grantKey, payload)},
	}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.RegisterEndpoint(stream) }()
	t.Cleanup(cancel)
	return stream, result, cancel
}

func waitRegistered(t *testing.T, stream *registerStream, result chan error) {
	t.Helper()
	select {
	case message := <-stream.sent:
		if message.GetRegistered() == nil {
			t.Fatalf("unexpected endpoint control %v", message)
		}
	case err := <-result:
		t.Fatalf("registration refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("registration timed out")
	}
}

func waitEnded(t *testing.T, result chan error, code codes.Code, contains string) {
	t.Helper()
	select {
	case err := <-result:
		if status.Code(err) != code || !strings.Contains(err.Error(), contains) {
			t.Fatalf("registration ended with %v, want %v containing %q", err, code, contains)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("registration did not end with %v", code)
	}
}

func TestLeaseBoundRegistrationFollowsTheGate(t *testing.T) {
	f := newLeaseFixture(t)
	_, refused, _ := f.register(t, "lease-ep")
	waitEnded(t, refused, codes.FailedPrecondition, "availability lease gate closed")

	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.register(t, "lease-ep")
	waitRegistered(t, stream, result)
	if next := f.broker.EnforceLeaseGates(); next != 20*time.Second {
		t.Fatalf("next gate deadline = %s", next)
	}
	if registered, _ := f.broker.Counts(); registered != 1 {
		t.Fatalf("registered endpoints = %d", registered)
	}

	// The gate closes (window elapsed or superseded): the registration is
	// dropped at the next enforcement.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Reason: "superseded"})
	f.broker.EnforceLeaseGates()
	waitEnded(t, result, codes.Aborted, "availability lease gate closed: superseded")
	if registered, _ := f.broker.Counts(); registered != 0 {
		t.Fatalf("registered endpoints after the gate closed = %d", registered)
	}

	// A lease-closed policy is back on legacy admission.
	f.gate.set("policy-1", "node-a", LeaseAdmission{})
	legacy, legacyResult, _ := f.register(t, "lease-ep")
	waitRegistered(t, legacy, legacyResult)
}

func TestPlainRegistrationIgnoresTheLeaseGate(t *testing.T) {
	f := newLeaseFixture(t)
	stream, result, _ := f.register(t, "plain-ep")
	waitRegistered(t, stream, result)
	if next := f.broker.EnforceLeaseGates(); next != 0 {
		t.Fatalf("plain registration depends on a gate: %s", next)
	}
	select {
	case err := <-result:
		t.Fatalf("plain registration ended: %v", err)
	default:
	}
}

func TestLeaseGateClosesSourceAndTargetBoundTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	b := f.broker
	snapshot := b.store.Current()
	tunnel := func(routeID, endpointID string) *activeTunnel {
		return &activeTunnel{routeID: routeID, routeGeneration: 1, endpointID: endpointID, endpointGeneration: 1, stop: make(chan struct{})}
	}
	database, proxy, plain := tunnel("db-route", "plain-ep"), tunnel("proxy-route", "lease-ep"), tunnel("plain-route", "plain-ep")
	b.active["database"], b.active["proxy"], b.active["plain"] = database, proxy, plain

	b.mu.Lock()
	for _, routeID := range []string{"db-route", "proxy-route"} {
		route := snapshot.Route(routeID, 0)
		if err := b.tunnelLeaseErrorLocked(route, snapshot.Endpoint(route.TargetEndpointId, 0)); status.Code(err) != codes.FailedPrecondition {
			t.Fatalf("%s opened while the gate is closed: %v", routeID, err)
		}
	}
	plainRoute := snapshot.Route("plain-route", 0)
	if err := b.tunnelLeaseErrorLocked(plainRoute, snapshot.Endpoint(plainRoute.TargetEndpointId, 0)); err != nil {
		t.Fatalf("plain route refused: %v", err)
	}
	b.mu.Unlock()

	b.EnforceLeaseGates()
	for name, session := range map[string]*activeTunnel{"database": database, "proxy": proxy} {
		select {
		case <-session.stop:
		default:
			t.Fatalf("%s tunnel stayed open with a closed gate", name)
		}
	}
	select {
	case <-plain.stop:
		t.Fatal("plain tunnel was closed by the lease gate")
	default:
	}
}
