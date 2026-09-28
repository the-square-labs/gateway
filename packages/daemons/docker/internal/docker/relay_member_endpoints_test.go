package docker

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	memberLeaseLink  = "11111111-1111-4111-8111-111111111111"
	memberLegacyLink = "22222222-2222-4222-8222-222222222222"
	memberPlainLink  = "33333333-3333-4333-8333-333333333333"
)

// memberPluginForTest is a lease plugin whose Secure Link targets are a
// lease-mode member (policy-1), a member of a policy outside lease mode and a
// plain link.
func memberPluginForTest(t *testing.T) *DockerPlugin {
	t.Helper()
	plugin := leasePluginForTest(t)
	plugin.memberReadiness = newMemberReadiness()
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(&pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: memberLeaseLink, Role: "target", TargetContainer: "gwav-1", AvailabilityPolicyId: "policy-1", AvailabilityCandidateId: "node-1", Dormant: true},
		{LinkId: memberLegacyLink, Role: "target", TargetContainer: "app", AvailabilityPolicyId: "legacy-policy"},
		{LinkId: memberPlainLink, Role: "target", TargetContainer: "plain"},
	}}); err != nil {
		t.Fatal(err)
	}
	plugin.secureLinkState = store
	return plugin
}

func setServing(plugin *DockerPlugin, policyID string, serving bool) {
	plugin.lease.mu.Lock()
	plugin.lease.serving[policyID] = serving
	plugin.lease.mu.Unlock()
}

func TestMemberEndpointStateFollowsServingAndReadiness(t *testing.T) {
	plugin := memberPluginForTest(t)
	const (
		unspecified = relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
		dormant     = relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
		serving     = relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	)
	if got := plugin.memberEndpointState(memberPlainLink); got != unspecified {
		t.Fatalf("plain link state = %v", got)
	}
	// D7: a standby registers, dormant.
	if got := plugin.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("standby state = %v", got)
	}
	// D6: the holder stays dormant until its workload is ready.
	setServing(plugin, "policy-1", true)
	if got := plugin.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("holder state before its workload is ready = %v", got)
	}
	plugin.memberReadiness.set("policy-1", true, "c1", time.Now())
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("ready holder state = %v", got)
	}
	// Outside lease mode the member serves once ready.
	if got := plugin.memberEndpointState(memberLegacyLink); got != dormant {
		t.Fatalf("legacy member before ready = %v", got)
	}
	plugin.memberReadiness.set("legacy-policy", true, "c2", time.Now())
	if got := plugin.memberEndpointState(memberLegacyLink); got != serving {
		t.Fatalf("ready legacy member = %v", got)
	}
	// Released or fenced: dormant at once, whatever the last probe said.
	setServing(plugin, "policy-1", false)
	if got := plugin.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("released holder state = %v", got)
	}
}

type scriptedMemberProbe struct {
	mu      sync.Mutex
	results map[string]memberProbeResult
	calls   []string
}

func (s *scriptedMemberProbe) probe(_ context.Context, links []string, cheap bool) memberProbeResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	kind := "full"
	if cheap {
		kind = "cheap"
	}
	s.calls = append(s.calls, links[0]+":"+kind)
	if result, ok := s.results[links[0]+":"+kind]; ok {
		return result
	}
	return s.results[links[0]]
}

func (s *scriptedMemberProbe) take() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	calls := s.calls
	s.calls = nil
	return calls
}

func TestMemberReadinessProbesOnlyServingMembersAndKeepsItWithoutEvidence(t *testing.T) {
	plugin := memberPluginForTest(t)
	probe := &scriptedMemberProbe{results: map[string]memberProbeResult{
		memberLegacyLink: {ready: false, fingerprint: "app@1", known: true},
		memberLeaseLink:  {ready: true, fingerprint: "gwav@1", known: true},
	}}
	plugin.memberProbe = probe.probe
	now := time.Now()

	// The standby is not probed; the legacy member is, and is not ready yet.
	if plugin.refreshMemberReadiness(context.Background(), now) {
		t.Fatal("nothing became ready")
	}
	if calls := probe.take(); len(calls) != 1 || calls[0] != memberLegacyLink+":full" {
		t.Fatalf("probes = %v", calls)
	}
	// The holder serves: probed at once, ready.
	setServing(plugin, "policy-1", true)
	if !plugin.refreshMemberReadiness(context.Background(), now) || !plugin.memberReadiness.ready("policy-1") {
		t.Fatal("the serving holder did not become ready")
	}
	probe.take()
	// dockerd does not answer: no evidence, the legacy member stays not ready
	// and the ready holder is not re-checked inside the re-check period.
	probe.results[memberLegacyLink] = memberProbeResult{}
	if plugin.refreshMemberReadiness(context.Background(), now.Add(time.Second)) {
		t.Fatal("a probe without evidence changed readiness")
	}
	if calls := probe.take(); len(calls) != 1 || calls[0] != memberLegacyLink+":full" {
		t.Fatalf("probes without evidence = %v", calls)
	}
	// Past the re-check period a ready member is re-checked cheaply; its
	// container restarted (new fingerprint), so it is probed in full, and it
	// is not ready yet.
	probe.results[memberLeaseLink+":cheap"] = memberProbeResult{ready: true, fingerprint: "gwav@2", known: true}
	probe.results[memberLeaseLink+":full"] = memberProbeResult{ready: false, fingerprint: "gwav@2", known: true}
	if !plugin.refreshMemberReadiness(context.Background(), now.Add(memberReadinessRecheck+time.Second)) || plugin.memberReadiness.ready("policy-1") {
		t.Fatal("a restarted holder container must be probed again before it serves")
	}
	var leaseCalls []string
	for _, call := range probe.take() {
		if call != memberLegacyLink+":full" {
			leaseCalls = append(leaseCalls, call)
		}
	}
	if len(leaseCalls) != 2 || leaseCalls[0] != memberLeaseLink+":cheap" || leaseCalls[1] != memberLeaseLink+":full" {
		t.Fatalf("re-check probes = %v", leaseCalls)
	}
	// Stops serving: readiness is forgotten, so the next serve probes afresh.
	plugin.memberReadiness.set("policy-1", true, "gwav@2", now)
	setServing(plugin, "policy-1", false)
	if !plugin.refreshMemberReadiness(context.Background(), now.Add(2*memberReadinessRecheck)) {
		t.Fatal("a member that stopped serving must report the change")
	}
	if _, known := plugin.memberReadiness.entry("policy-1"); known {
		t.Fatal("readiness of a member that stopped serving was kept")
	}
}

type stateRecordingBrokerClient struct {
	relayv1.TunnelBrokerClient
	messages chan *relayv1.EndpointControl
}

func (c *stateRecordingBrokerClient) RegisterEndpoint(ctx context.Context, _ ...grpc.CallOption) (grpc.BidiStreamingClient[relayv1.EndpointControl, relayv1.EndpointControl], error) {
	return &stateRecordingStream{ctx: ctx, messages: c.messages}, nil
}

type stateRecordingStream struct {
	grpc.ClientStream
	ctx      context.Context
	messages chan *relayv1.EndpointControl
}

func (s *stateRecordingStream) Send(message *relayv1.EndpointControl) error {
	s.messages <- message
	return nil
}

func (s *stateRecordingStream) Recv() (*relayv1.EndpointControl, error) {
	<-s.ctx.Done()
	return nil, errors.New("closed")
}

func nextEndpointControl(t *testing.T, messages chan *relayv1.EndpointControl) *relayv1.EndpointControl {
	t.Helper()
	select {
	case message := <-messages:
		return message
	case <-time.After(5 * time.Second):
		t.Fatal("no endpoint control message")
		return nil
	}
}

// D7: every member link registers, dormant until it serves and is ready; the
// state changes ride renewals of the same registration.
func TestMemberEndpointsRegisterDormantAndRenewWhenTheyServe(t *testing.T) {
	plugin := memberPluginForTest(t)
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, Grants: []*pb.RelayGrantAssignment{
		{Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: memberLeaseLink, EndpointId: "endpoint-lease", Grant: &pb.RelaySignedGrant{KeyId: "k-lease"}},
		{Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: memberPlainLink, EndpointId: "endpoint-plain", Grant: &pb.RelaySignedGrant{KeyId: "k-plain"}},
	}}); err != nil {
		t.Fatal(err)
	}
	plugin.relayGrants = store
	client := &stateRecordingBrokerClient{messages: make(chan *relayv1.EndpointControl, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router := &relayTunnelRouter{plugin: plugin, ctx: ctx, client: client, targetID: relaybridge.LegacyTargetID, registrations: map[string]*relayEndpointRegistration{}}
	plugin.relayTunnels = map[string]*relayTunnelRouter{relaybridge.LegacyTargetID: router}

	router.reconcileRegistrations()
	states := map[string]relayv1.EndpointServingState{}
	for range 2 {
		message := nextEndpointControl(t, client.messages)
		register := message.GetRegister()
		if register == nil {
			t.Fatalf("first message = %v", message)
		}
		states[register.GetGrant().GetKeyId()] = register.GetState()
	}
	if states["k-lease"] != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT ||
		states["k-plain"] != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED || len(states) != 2 {
		t.Fatalf("registration states = %v, want the standby dormant and the plain link unspecified", states)
	}

	setServing(plugin, "policy-1", true)
	plugin.memberReadiness.set("policy-1", true, "c", time.Now())
	router.reconcileRegistrations()
	renew := nextEndpointControl(t, client.messages).GetRenew()
	if renew == nil || renew.GetState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING {
		t.Fatalf("serving renewal = %v", renew)
	}
	// An unchanged state is not renewed again.
	router.reconcileRegistrations()
	select {
	case message := <-client.messages:
		t.Fatalf("unchanged registration renewed: %v", message)
	case <-time.After(50 * time.Millisecond):
	}

	// Released: dormant again, on the same registration.
	plugin.lease.SetServing("policy-1", false)
	renew = nextEndpointControl(t, client.messages).GetRenew()
	if renew == nil || renew.GetState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("released renewal = %v", renew)
	}
	if len(router.registrations) != 2 {
		t.Fatalf("registrations after release = %d, want both kept", len(router.registrations))
	}
}

func TestStoppingToServeClosesTheMembersAcceptedTunnels(t *testing.T) {
	plugin := memberPluginForTest(t)
	router := &relayTunnelRouter{plugin: plugin, accepted: map[*acceptedRelayTunnel]struct{}{}}
	plugin.relayTunnels = map[string]*relayTunnelRouter{"relay-1": router}
	cancelled := map[string]bool{}
	for _, endpointID := range []string{"endpoint-lease", "endpoint-other"} {
		tunnel := &acceptedRelayTunnel{endpointID: endpointID, done: make(chan struct{})}
		tunnel.cancel = func() { cancelled[tunnel.endpointID] = true; close(tunnel.done) }
		router.accepted[tunnel] = struct{}{}
	}
	closing := plugin.closeMemberTunnels(map[string]bool{"endpoint-lease": true})
	if len(closing) != 1 || !cancelled["endpoint-lease"] || cancelled["endpoint-other"] {
		t.Fatalf("closed %v (%d waits)", cancelled, len(closing))
	}
	<-closing[0]
}

func TestRelayRegistrationRetryBacksOffWithJitter(t *testing.T) {
	for attempt, want := range map[int][2]time.Duration{
		1: {500 * time.Millisecond, time.Second},
		2: {time.Second, 2 * time.Second},
		3: {2 * time.Second, 4 * time.Second},
		5: {7500 * time.Millisecond, 15 * time.Second},
		9: {7500 * time.Millisecond, 15 * time.Second},
	} {
		low := relayRegistrationRetryDelay(attempt, func() float64 { return 0 })
		high := relayRegistrationRetryDelay(attempt, func() float64 { return 0.999999 })
		if low != want[0] || high < want[1]-time.Millisecond || high > want[1] {
			t.Fatalf("attempt %d delays [%s, %s], want [%s, %s)", attempt, low, high, want[0], want[1])
		}
	}
}

// E's B-18 leftover: a registration refused because its grant and the relay's policy do not match yet is retried on
// a short cadence for the first seconds (the policy or the grant follows within seconds), then with the backoff.
func TestPolicyMismatchRetriesOnAShortCadence(t *testing.T) {
	mismatch := status.Error(codes.PermissionDenied, "endpoint grant does not match policy")
	low, high := func() float64 { return 0 }, func() float64 { return 0.999999 }
	for _, failures := range []int{1, 5, 20} {
		for _, random := range []func() float64{low, high} {
			if delay := nextRegistrationRetry(mismatch, failures, 3*time.Second, random); delay < 200*time.Millisecond || delay > 400*time.Millisecond {
				t.Fatalf("policy mismatch retry after %d failures = %s", failures, delay)
			}
		}
	}
	if delay := nextRegistrationRetry(mismatch, 5, 11*time.Second, low); delay != relayRegistrationRetryDelay(5, low) {
		t.Fatalf("a mismatch that outlived the window retried after %s", delay)
	}
	other := status.Error(codes.Unavailable, "connection refused")
	if delay := nextRegistrationRetry(other, 3, 0, low); delay != relayRegistrationRetryDelay(3, low) {
		t.Fatalf("another refusal retried after %s", delay)
	}
	if relayPolicyCatchingUp(status.Error(codes.PermissionDenied, "grant subject is invalid")) {
		t.Fatal("a refused identity counted as a policy catching up")
	}
}

func TestDeploymentRouterProbeTellsTheAppFromTheRouter(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		marked bool
		ready  bool
	}{
		"app answers":          {status: http.StatusOK, ready: true},
		"app answers 404":      {status: http.StatusNotFound, ready: true},
		"router marks its 502": {status: http.StatusBadGateway, marked: true},
		"router marks its 504": {status: http.StatusGatewayTimeout, marked: true},
		"unmarked 502":         {status: http.StatusBadGateway},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.marked {
					w.Header().Set(deploymentRouterUnavailableHeader, "upstream-unavailable")
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			if got := probeDeploymentRouter(context.Background(), server.Listener.Addr().String()); got != tc.ready {
				t.Fatalf("ready = %v, want %v", got, tc.ready)
			}
		})
	}
}

func TestTCPProbeThroughConnectorNeedsTheTargetToAccept(t *testing.T) {
	accepting, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer accepting.Close()
	go func() {
		for {
			connection, err := accepting.Accept()
			if err != nil {
				return
			}
			defer connection.Close()
		}
	}()
	if !probeTCPThroughConnector(context.Background(), accepting.Addr().String()) {
		t.Fatal("an accepting target is not ready")
	}
	// The connector accepts, then closes at once when the target refuses.
	refusing, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer refusing.Close()
	go func() {
		for {
			connection, err := refusing.Accept()
			if err != nil {
				return
			}
			connection.Close()
		}
	}()
	if probeTCPThroughConnector(context.Background(), refusing.Addr().String()) {
		t.Fatal("a refusing target is ready")
	}
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	address := closed.Addr().String()
	closed.Close()
	if probeTCPThroughConnector(context.Background(), address) {
		t.Fatal("no connector is ready")
	}
}

type bootstrapLeaseView struct {
	pending, holds, recovering bool
}

func (v *bootstrapLeaseView) LeaseMode(string) bool        { return true }
func (v *bootstrapLeaseView) BootstrapPending(string) bool { return v.pending }
func (v *bootstrapLeaseView) Holds(string) bool            { return v.holds || v.recovering }
func (v *bootstrapLeaseView) Recovering(string) bool       { return v.recovering }

// B-13: after a same-boot daemon restart the holder recovers its running copy
// on a live lease record; its member endpoint registers serving from the
// first registration (no dormant announcement), keeps serving through
// SetServing(true) and the renewal, and only this process's first readiness
// probe can take it out. A holder without that proof registers dormant.
func TestRecoveredHolderServesFromItsFirstRegistration(t *testing.T) {
	serving := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	dormant := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	plugin := memberPluginForTest(t)
	view := &bootstrapLeaseView{recovering: true}
	plugin.lease.view = view
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("recovered holder's first registration = %v", got)
	}
	plugin.lease.SetServing("policy-1", true)
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("recovered holder after SetServing(true) = %v", got)
	}
	// The renewal succeeded: holding, still not probed.
	view.recovering, view.holds = false, true
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("recovered holder after its renewal = %v", got)
	}
	// This process's first probe judges it.
	plugin.memberReadiness.set("policy-1", false, "c", time.Now())
	if got := plugin.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("a probe that finds the copy not ready = %v", got)
	}
	plugin.memberReadiness.set("policy-1", true, "c", time.Now())
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("a ready copy = %v", got)
	}

	// No proof (its lease lapsed, or a new boot: no live record): dormant
	// until it acquires and SetServing opens it.
	other := memberPluginForTest(t)
	other.lease.view = &bootstrapLeaseView{}
	if got := other.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("holder without a live record = %v", got)
	}
	// A stop under way (SetServing(false)) wins over the recovery.
	stopping := memberPluginForTest(t)
	stopping.lease.view = &bootstrapLeaseView{recovering: true}
	stopping.lease.SetServing("policy-1", false)
	if got := stopping.memberEndpointState(memberLeaseLink); got != dormant {
		t.Fatalf("recovered holder whose stop began = %v", got)
	}
}

// Agent A's note on enable: when the named bootstrap holder acquires, its
// legacy copy keeps serving until the runtime's SetServing takes over, with
// no dormant gap in between; a lost bootstrap race ends it.
func TestBootstrapHolderServesWithoutAGapUntilTheRuntimeTakesOver(t *testing.T) {
	plugin := memberPluginForTest(t)
	view := &bootstrapLeaseView{pending: true}
	plugin.lease.view = view
	plugin.memberReadiness.set("policy-1", true, "c", time.Now())
	serving := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("bootstrap holder before its commit = %v", got)
	}
	// Committed: BootstrapPending ends, SetServing has not run yet.
	view.pending, view.holds = false, true
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("bootstrap holder between its commit and SetServing = %v", got)
	}
	// The runtime opens the endpoints: readiness is kept, no re-probe gap.
	plugin.lease.SetServing("policy-1", true)
	if got := plugin.memberEndpointState(memberLeaseLink); got != serving {
		t.Fatalf("bootstrap holder after SetServing = %v", got)
	}

	// Another node won the bootstrap race: the copy stops serving at once.
	other := memberPluginForTest(t)
	otherView := &bootstrapLeaseView{pending: true}
	other.lease.view = otherView
	other.memberReadiness.set("policy-1", true, "c", time.Now())
	other.memberEndpointState(memberLeaseLink)
	otherView.pending, otherView.holds = false, false
	if got := other.memberEndpointState(memberLeaseLink); got != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("lost bootstrap = %v", got)
	}
	otherView.holds = true
	if got := other.memberEndpointState(memberLeaseLink); got != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("the bridge came back after it ended: %v", got)
	}
}

// B-12b (stand, bootstrapping -> lease at 14:34:28): a member link is plain to
// the daemon until its policy is in lease mode, then its binding names the
// policy. The holder's copy kept serving, but its readiness was not known yet,
// so the link went DORMANT: the relay reset every tunnel through it and nginx
// closed the socket, a 1.9 s burst of 502 until the probe put it back. A flip
// happens only on evidence now: the link stays SERVING, with its tunnels,
// until a probe says otherwise.
func TestLinkEnteringLeaseModeKeepsServingWithItsTunnels(t *testing.T) {
	plugin := memberPluginForTest(t)
	const link = "44444444-4444-4444-8444-444444444444"
	commit := func(policyID string) {
		t.Helper()
		if err := plugin.secureLinkState.Commit(&pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
			{LinkId: link, Role: "target", TargetContainer: "gwav-hafo", AvailabilityPolicyId: policyID, Dormant: policyID != ""},
		}}); err != nil {
			t.Fatal(err)
		}
	}
	commit("") // bootstrapping: a plain link
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, Grants: []*pb.RelayGrantAssignment{
		{Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: link, EndpointId: "endpoint-hafo", Grant: &pb.RelaySignedGrant{KeyId: "k"}},
	}}); err != nil {
		t.Fatal(err)
	}
	plugin.relayGrants = store
	client := &stateRecordingBrokerClient{messages: make(chan *relayv1.EndpointControl, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router := &relayTunnelRouter{plugin: plugin, ctx: ctx, client: client, targetID: relaybridge.LegacyTargetID,
		registrations: map[string]*relayEndpointRegistration{}, accepted: map[*acceptedRelayTunnel]struct{}{}}
	plugin.relayTunnels = map[string]*relayTunnelRouter{relaybridge.LegacyTargetID: router}

	router.reconcileRegistrations()
	if register := nextEndpointControl(t, client.messages).GetRegister(); register.GetState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED {
		t.Fatalf("plain link registered as %v", register.GetState())
	}
	// A live connection through the link.
	cancelled := false
	tunnel := &acceptedRelayTunnel{endpointID: "endpoint-hafo", done: make(chan struct{}), cancel: func() { cancelled = true }}
	router.mu.Lock()
	router.accepted[tunnel] = struct{}{}
	router.mu.Unlock()

	// Lease mode: this node holds the slot, its copy kept running; the probe
	// has not run yet.
	setServing(plugin, "policy-1", true)
	commit("policy-1")
	router.reconcileRegistrations()
	renew := nextEndpointControl(t, client.messages).GetRenew()
	if renew == nil || renew.GetState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING {
		t.Fatalf("link entering lease mode renewed as %v, want SERVING in place", renew)
	}
	// The probe confirms it: no further renewal, the tunnel lives on.
	plugin.memberProbe = func(context.Context, []string, bool) memberProbeResult {
		return memberProbeResult{ready: true, fingerprint: "hafo@1", known: true}
	}
	if !plugin.refreshMemberReadiness(context.Background(), time.Now()) {
		t.Fatal("the probe result was not recorded")
	}
	router.reconcileRegistrations()
	select {
	case message := <-client.messages:
		t.Fatalf("a confirmed serving link was renewed again: %v", message)
	case <-time.After(50 * time.Millisecond):
	}
	if cancelled || len(router.registrations) != 1 {
		t.Fatalf("the flip broke the link: tunnel cancelled %v, registrations %d", cancelled, len(router.registrations))
	}

	// Evidence still flips it: a probe that finds the workload down.
	plugin.memberProbe = func(context.Context, []string, bool) memberProbeResult {
		return memberProbeResult{ready: false, fingerprint: "hafo@2", known: true}
	}
	plugin.memberReadiness.set("policy-1", true, "hafo@1", time.Now().Add(-time.Minute))
	plugin.refreshMemberReadiness(context.Background(), time.Now())
	router.reconcileRegistrations()
	if renew := nextEndpointControl(t, client.messages).GetRenew(); renew.GetState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("a member found not ready renewed as %v", renew.GetState())
	}
}

// A link that never took traffic (a standby, or a new successor) does not get
// the benefit of the doubt: it stays DORMANT until its probe says ready.
func TestLinkThatNeverServedStaysDormantUntilProbed(t *testing.T) {
	plugin := memberPluginForTest(t)
	setServing(plugin, "policy-1", true)
	if got := plugin.memberEndpointState(memberLeaseLink); got != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("unprobed new holder = %v", got)
	}
	// Leaving the serving set is evidence too, whatever the link did before.
	plugin.memberReadiness.recordState(memberLeaseLink, relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	setServing(plugin, "policy-1", false)
	if got := plugin.memberEndpointState(memberLeaseLink); got != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
		t.Fatalf("released holder = %v", got)
	}
}
