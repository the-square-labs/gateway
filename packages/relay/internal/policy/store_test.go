package policy

import (
	"crypto/ed25519"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
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

func TestBootstrapPolicyTrustRejectsMismatchAndSubstitution(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	otherKey, _, _ := ed25519.GenerateKey(nil)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("mismatched public key and fingerprint were accepted")
	}
	if unchanged, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(publicKey)); err != nil || unchanged {
		t.Fatalf("initial trust bootstrap failed: unchanged=%v err=%v", unchanged, err)
	}
	if unchanged, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(publicKey)); err != nil || !unchanged {
		t.Fatalf("idempotent trust bootstrap failed: unchanged=%v err=%v", unchanged, err)
	}
	if _, err := store.BootstrapPolicyTrust("policy-1", otherKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("substituted first key was accepted")
	}
	if _, err := store.BootstrapPolicyTrust("policy-2", otherKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("unsigned second key was accepted")
	}
}

func TestRemoteRelayRejectsLegacySnapshot(t *testing.T) {
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, _, err := store.Apply(validSnapshot(grantPublic)); err == nil {
		t.Fatal("remote relay accepted an unsigned legacy snapshot")
	}
}

func TestSignedPolicyLeaseReplayAndRestart(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	options := Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return now },
	}
	store, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	request := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)
	if _, _, err := store.Apply(request); err != nil {
		t.Fatal(err)
	}
	if _, unchanged, err := store.Apply(request); err != nil || !unchanged {
		t.Fatalf("identical signed policy was not idempotent: unchanged=%v err=%v", unchanged, err)
	}
	next := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 2, now)
	if _, _, err := store.Apply(next); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("valid older signed policy replay was accepted")
	}
	if err := store.AdmissionError(now.Add(PolicyLease - time.Second)); err != nil {
		t.Fatalf("policy expired early: %v", err)
	}
	now = now.Add(PolicyLease)
	if err := store.AdmissionError(now); err == nil {
		t.Fatal("expired policy still admitted new tunnels")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatalf("expired policy must remain loadable for existing-stream continuity: %v", err)
	}
	defer reopened.Close()
	if reopened.Ready(now) {
		t.Fatal("expired persisted policy reported ready after restart")
	}
	tampered := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 3, now.Add(-time.Minute))
	tampered.SignedEnvelope.Payload[0] ^= 0x01
	if _, _, err := reopened.Apply(tampered); err == nil {
		t.Fatal("tampered policy envelope was accepted")
	}
}

func TestSignedPolicyKeyRotationRemovesOldSigner(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	first := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 1, now, []*relayv1.PolicySigningKey{
		policyKey("old", oldPublic), policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(first); err != nil {
		t.Fatalf("old-signs-new rotation failed: %v", err)
	}
	second := signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 2, now.Add(time.Minute), []*relayv1.PolicySigningKey{
		policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(second); err != nil {
		t.Fatalf("new signer activation failed: %v", err)
	}
	oldSignedAgain := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 3, now.Add(2*time.Minute), []*relayv1.PolicySigningKey{
		policyKey("old", oldPublic), policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(oldSignedAgain); err == nil {
		t.Fatal("retired policy signer was accepted")
	}
}

func TestSignedPolicyKeepsActiveAndStagingAssignmentGenerations(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	request := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(request.SignedEnvelope.Payload, payload); err != nil {
		t.Fatal(err)
	}
	stagingEndpoint := proto.Clone(payload.Endpoints[0]).(*relayv1.EndpointPolicy)
	stagingEndpoint.AssignmentGeneration = 2
	payload.Endpoints = append(payload.Endpoints, stagingEndpoint)
	stagingRoute := proto.Clone(payload.Routes[0]).(*relayv1.RoutePolicy)
	stagingRoute.AssignmentGeneration = 2
	payload.Routes = append(payload.Routes, stagingRoute)
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request.SignedEnvelope.Payload = encoded
	request.SignedEnvelope.Signature = ed25519.Sign(policyPrivate, encoded)
	snapshot, _, err := store.Apply(request)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Endpoint("endpoint-1", 1) == nil || snapshot.Endpoint("endpoint-1", 2) == nil {
		t.Fatal("active and staging endpoint assignments were not retained")
	}
	if snapshot.Route("route-1", 1) == nil || snapshot.Route("route-1", 2) == nil {
		t.Fatal("active and staging route assignments were not retained")
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

func signedSnapshot(t *testing.T, policyPrivate ed25519.PrivateKey, policyKeyID string, policyPublic, grantPublic ed25519.PublicKey, revision uint64, now time.Time) *relayv1.ApplySnapshotRequest {
	t.Helper()
	return signedSnapshotWithPolicyKeys(t, policyPrivate, policyKeyID, grantPublic, revision, now, []*relayv1.PolicySigningKey{
		policyKey(policyKeyID, policyPublic),
	})
}

func signedSnapshotWithPolicyKeys(t *testing.T, privateKey ed25519.PrivateKey, keyID string, grantPublic ed25519.PublicKey, revision uint64, now time.Time, policyKeys []*relayv1.PolicySigningKey) *relayv1.ApplySnapshotRequest {
	t.Helper()
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: "gateway-1", PoolId: "system", RelayInstanceId: "relay-1",
		Revision: revision, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(PolicyLease).Unix(),
		GrantPublicKeys: []*relayv1.PublicKey{{KeyId: "grant-1", PublicKey: grantPublic}},
		Endpoints: []*relayv1.EndpointPolicy{{
			EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target",
			CertificateSha256: "sha256:target", PoolId: "system", RelayInstanceId: "relay-1", AssignmentGeneration: 1,
		}},
		Routes: []*relayv1.RoutePolicy{{
			RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source",
			SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1", AssignmentGeneration: 1,
		}},
		Capabilities: []string{PoolCapability}, PolicySigningKeys: policyKeys,
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.ApplySnapshotRequest{SignedEnvelope: &relayv1.SignedPolicyEnvelope{
		SigningKeyId: keyID, Payload: encoded, Signature: ed25519.Sign(privateKey, encoded),
	}}
}

func policyKey(keyID string, publicKey ed25519.PublicKey) *relayv1.PolicySigningKey {
	return &relayv1.PolicySigningKey{
		KeyId: keyID, PublicKey: publicKey, PublicKeyFingerprint: PublicKeyFingerprint(publicKey), Status: "active",
	}
}
