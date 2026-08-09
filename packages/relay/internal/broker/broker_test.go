package broker

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

type frameReceiver struct {
	frames []*relayv1.TunnelFrame
}

func (r *frameReceiver) Recv() (*relayv1.TunnelFrame, error) {
	if len(r.frames) == 0 {
		return nil, io.EOF
	}
	frame := r.frames[0]
	r.frames = r.frames[1:]
	return frame, nil
}

type frameSender struct {
	frames []*relayv1.TunnelFrame
}

type blockingFrameStream struct {
	mu     sync.Mutex
	frames []*relayv1.TunnelFrame
	stop   chan struct{}
}

func (s *blockingFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	<-s.stop
	return nil, io.EOF
}

func (s *blockingFrameStream) Send(frame *relayv1.TunnelFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
	return nil
}

func (s *frameSender) Send(frame *relayv1.TunnelFrame) error {
	s.frames = append(s.frames, frame)
	return nil
}

type acceptStream struct {
	relayv1.TunnelBroker_AcceptTunnelServer
	ctx   context.Context
	first *relayv1.TunnelFrame
}

func (s *acceptStream) Context() context.Context { return s.ctx }
func (s *acceptStream) Recv() (*relayv1.TunnelFrame, error) {
	frame := s.first
	s.first = nil
	return frame, nil
}
func (s *acceptStream) Send(*relayv1.TunnelFrame) error { return nil }
func (s *acceptStream) SetHeader(metadata.MD) error     { return nil }
func (s *acceptStream) SendHeader(metadata.MD) error    { return nil }
func (s *acceptStream) SetTrailer(metadata.MD)          {}
func (s *acceptStream) SendMsg(any) error               { return nil }
func (s *acceptStream) RecvMsg(any) error               { return nil }

func TestAcceptTokenIsSingleUse(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", SubjectId: "node-target", CertificateSha256: "sha256:target"}
	pending := &pendingTunnel{endpoint: endpoint, session: &activeTunnel{stop: make(chan struct{})}, accepted: make(chan acceptedConnection, 1)}
	b.pending["token-1"] = pending
	ctx := authenticatedContext("node-target", []byte("target"))
	// Match the synthetic certificate fingerprint used in the pending policy.
	identity, _ := grpcpeer.FromContext(ctx)
	fingerprint := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	endpoint.CertificateSha256 = fmt.Sprintf("sha256:%x", sha256.Sum256(fingerprint.Raw))
	first := &acceptStream{ctx: ctx, first: acceptFrame("token-1")}
	done := make(chan error, 1)
	go func() { done <- b.AcceptTunnel(first) }()
	connection := <-pending.accepted
	connection.result <- nil
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	second := &acceptStream{ctx: ctx, first: acceptFrame("token-1")}
	if code := status.Code(b.AcceptTunnel(second)); code != codes.NotFound {
		t.Fatalf("replayed token status = %v", code)
	}
}

func TestCapacityIncludesReservedSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	b.active["reserved"] = &activeTunnel{routeID: "route-1", endpointID: "endpoint-1", stop: make(chan struct{})}
	route := &relayv1.RoutePolicy{RouteId: "route-1", MaxConcurrentSessions: 1}
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", MaxConcurrentSessions: 1}
	if code := status.Code(b.checkCapacityLocked(route, endpoint, 1)); code != codes.ResourceExhausted {
		t.Fatalf("capacity status = %v", code)
	}
}

func TestCapacityPreservesAggregateSourcePrincipalLimit(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	for index := 0; index < DefaultPrincipalSessions; index++ {
		b.active[fmt.Sprintf("session-%d", index)] = &activeTunnel{
			routeID:    fmt.Sprintf("route-%d", index),
			sourceKind: "gateway",
			sourceID:   "gateway-1",
			endpointID: fmt.Sprintf("endpoint-%d", index),
			stop:       make(chan struct{}),
		}
	}
	route := &relayv1.RoutePolicy{RouteId: "next-route", SourceKind: "gateway", SourceId: "gateway-1", MaxConcurrentSessions: 100}
	endpoint := &relayv1.EndpointPolicy{EndpointId: "next-endpoint", MaxConcurrentSessions: 256}
	if code := status.Code(b.checkCapacityLocked(route, endpoint, 100)); code != codes.ResourceExhausted {
		t.Fatalf("principal capacity status = %v", code)
	}
}

func TestReconcileClosesRevokedActiveSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	session := &activeTunnel{routeID: "route-1", routeGeneration: 1, endpointID: "endpoint-1", endpointGeneration: 1, stop: make(chan struct{})}
	b.active["session-1"] = session
	b.Reconcile(&policy.Snapshot{}, &policy.Snapshot{Routes: map[string]*relayv1.RoutePolicy{}, Endpoints: map[string]*relayv1.EndpointPolicy{}})
	select {
	case <-session.stop:
	default:
		t.Fatal("revoked session was not closed")
	}
	if _, exists := b.active["session-1"]; !exists {
		t.Fatal("revoked session was removed before its bridge exited")
	}
}

func TestEndpointDisconnectClosesActiveSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	session := &activeTunnel{endpointID: "endpoint-1", stop: make(chan struct{})}
	b.active["session-1"] = session
	b.mu.Lock()
	b.closeEndpointSessionsLocked("endpoint-1")
	b.mu.Unlock()
	select {
	case <-session.stop:
	default:
		t.Fatal("endpoint disconnect did not close its session")
	}
}

func TestPumpPreservesHalfClose(t *testing.T) {
	source := &frameReceiver{frames: []*relayv1.TunnelFrame{{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}}}
	destination := &frameSender{}
	terminal, err := pump(destination, source, DefaultMaxFrameBytes, make(chan struct{}, 1))
	if err != nil || terminal {
		t.Fatalf("half-close result terminal=%v err=%v", terminal, err)
	}
	if len(destination.frames) != 1 || destination.frames[0].GetHalfClose() == nil {
		t.Fatal("half-close was not forwarded")
	}
}

func TestBridgeClosesIdleTunnel(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	err := bridgeWithIdleTimeout(left, right, DefaultMaxFrameBytes, make(chan struct{}), 5*time.Millisecond)
	close(left.stop)
	close(right.stop)
	if status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("idle bridge status = %v", status.Code(err))
	}
	left.mu.Lock()
	leftFrames := len(left.frames)
	left.mu.Unlock()
	right.mu.Lock()
	rightFrames := len(right.frames)
	right.mu.Unlock()
	if leftFrames != 0 || rightFrames != 0 {
		t.Fatalf("idle timeout used a concurrent stream writer left=%d right=%d", leftFrames, rightFrames)
	}
}

func TestBridgeRevocationDoesNotAddConcurrentStreamWriters(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	revoked := make(chan struct{})
	close(revoked)
	err := bridgeWithIdleTimeout(left, right, DefaultMaxFrameBytes, revoked, time.Minute)
	close(left.stop)
	close(right.stop)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("revoked bridge status = %v", status.Code(err))
	}
	left.mu.Lock()
	leftFrames := len(left.frames)
	left.mu.Unlock()
	right.mu.Lock()
	rightFrames := len(right.frames)
	right.mu.Unlock()
	if leftFrames != 0 || rightFrames != 0 {
		t.Fatalf("revocation used a concurrent stream writer left=%d right=%d", leftFrames, rightFrames)
	}
}

func acceptFrame(token string) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: token}}}
}

func authenticatedContext(commonName string, raw []byte) context.Context {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: commonName}, SerialNumber: big.NewInt(1), Raw: raw}
	return grpcpeer.NewContext(context.Background(), &grpcpeer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate}}}}})
}
