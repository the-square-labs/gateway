package identity

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestServerTLSConfigPreservesGRPCALPNForDynamicCertificates(t *testing.T) {
	store := &Store{}
	store.current.Store(&Snapshot{})
	config := store.ServerTLSConfig()
	if !slices.Contains(config.NextProtos, "h2") {
		t.Fatalf("base TLS config does not advertise h2: %v", config.NextProtos)
	}
	dynamic, err := config.GetConfigForClient(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(dynamic.NextProtos, "h2") {
		t.Fatalf("dynamic TLS config lost h2 ALPN: %v", dynamic.NextProtos)
	}
}

func TestAppClientTrustSurvivesUncertainReloadAcknowledgement(t *testing.T) {
	store := &Store{}
	previous := "sha256:" + repeatHex("a")
	current := "sha256:" + repeatHex("b")
	store.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	store.rotation = rotationState{
		Version:             1,
		CurrentFingerprint:  current,
		PreviousFingerprint: previous,
		PendingOperationID:  "rotation-1",
	}

	if !store.AuthorizeAppClient(previous) {
		t.Fatal("previous app client identity was rejected before rotation commit")
	}
	if !store.AuthorizeAppClient(current) {
		t.Fatal("current app client identity was rejected")
	}
	if !store.AuthorizeAppClient(previous) {
		t.Fatal("health or another current-client RPC implicitly committed the rotation")
	}
	if err := store.CommitAppClientRotation("rotation-1", previous); err == nil {
		t.Fatal("previous client was allowed to commit the rotation")
	}
	if err := store.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("current client could not commit rotation: %v", err)
	}
	if store.AuthorizeAppClient(previous) {
		t.Fatal("previous app client identity remained trusted after explicit commit")
	}
	if err := store.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("identity rotation commit was not idempotent: %v", err)
	}
}

func TestAppClientRotationStateSurvivesRestart(t *testing.T) {
	current := "sha256:" + repeatHex("b")
	previous := "sha256:" + repeatHex("a")
	statePath := filepath.Join(t.TempDir(), "identity-rotation.json")
	store := &Store{statePath: statePath}
	store.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	store.rotation = rotationState{
		Version:             1,
		CurrentFingerprint:  current,
		PreviousFingerprint: previous,
		PendingOperationID:  "rotation-1",
	}
	if err := store.persistRotationState(store.rotation); err != nil {
		t.Fatalf("persist rotation state: %v", err)
	}

	restarted := &Store{statePath: statePath}
	restarted.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	if err := restarted.loadRotationState(current); err != nil {
		t.Fatalf("load rotation state: %v", err)
	}
	if !restarted.AuthorizeAppClient(previous) {
		t.Fatal("previous identity was not restored for an uncertain reload acknowledgement")
	}
	if err := restarted.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("commit restored rotation: %v", err)
	}
}

func TestAppClientCanInitiateRotationAfterFilesChangedBeforeRestart(t *testing.T) {
	previous := "sha256:" + repeatHex("a")
	current := "sha256:" + repeatHex("b")
	statePath := filepath.Join(t.TempDir(), "identity-rotation.json")
	before := &Store{statePath: statePath, rotation: rotationState{Version: 1, CurrentFingerprint: previous}}
	if err := before.persistRotationState(before.rotation); err != nil {
		t.Fatalf("persist previous identity state: %v", err)
	}

	restarted := &Store{statePath: statePath}
	restarted.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	if err := restarted.loadRotationState(current); err != nil {
		t.Fatalf("load changed identity state: %v", err)
	}
	if !restarted.AuthorizeAppClient(previous) {
		t.Fatal("previous Gateway identity was not retained across pre-reload restart")
	}
}

func repeatHex(value string) string {
	result := ""
	for range 64 {
		result += value
	}
	return result
}
