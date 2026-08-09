package policy

import (
	"crypto/ed25519"
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

func TestApplyIsDurableMonotonicAndIdempotent(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	request := validSnapshot(publicKey)
	applied, unchanged, err := store.Apply(request)
	if err != nil || unchanged || applied.Revision != 1 {
		t.Fatalf("unexpected first apply: applied=%v unchanged=%v err=%v", applied, unchanged, err)
	}
	if _, unchanged, err := store.Apply(request); err != nil || !unchanged {
		t.Fatalf("identical apply was not idempotent: unchanged=%v err=%v", unchanged, err)
	}
	conflict := validSnapshot(publicKey)
	conflict.GatewayInstanceId = "different"
	if _, _, err := store.Apply(conflict); err == nil {
		t.Fatal("conflicting content at one revision was accepted")
	}
	next := validSnapshot(publicKey)
	next.Revision = 2
	if _, _, err := store.Apply(next); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("older snapshot was accepted")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Current().Revision != 2 || reopened.Current().GatewayInstanceID != "gateway-1" {
		t.Fatalf("persisted snapshot was not restored: %#v", reopened.Current())
	}
}

func TestFullSnapshotRevocationSurvivesRestart(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(validSnapshot(publicKey)); err != nil {
		t.Fatal(err)
	}
	revoked := validSnapshot(publicKey)
	revoked.Revision = 2
	revoked.Endpoints = nil
	revoked.Routes = nil
	if _, _, err := store.Apply(revoked); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	current := reopened.Current()
	if current.Revision != 2 || len(current.Endpoints) != 0 || len(current.Routes) != 0 {
		t.Fatalf("revocation was not restored: %#v", current)
	}
}

func TestApplyRejectsRouteToUnknownEndpoint(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	request := validSnapshot(publicKey)
	request.Routes[0].TargetEndpointId = "missing"
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("route targeting an unknown endpoint was accepted")
	}
}

func validSnapshot(publicKey ed25519.PublicKey) *relayv1.ApplySnapshotRequest {
	return &relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "gateway-1",
		PublicKeys: []*relayv1.PublicKey{{KeyId: "key-1", PublicKey: publicKey}},
		Endpoints:  []*relayv1.EndpointPolicy{{EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target", CertificateSha256: "sha256:target"}},
		Routes:     []*relayv1.RoutePolicy{{RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1"}},
	}
}
