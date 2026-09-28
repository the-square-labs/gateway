package docker

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	dockerconfig "github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
)

// fakeRuntimeVerifier stands in for the runsc manager: its smoke test runs
// until release is closed, like six gVisor containers one after another.
type fakeRuntimeVerifier struct {
	pending runtimemanager.Status
	verify  bool
	result  runtimemanager.Status
	release chan struct{}
	started chan struct{}
}

func (f *fakeRuntimeVerifier) PreflightWithoutSmokeTest(context.Context) (runtimemanager.Status, bool) {
	return f.pending, f.verify
}

func (f *fakeRuntimeVerifier) VerifyRuntime(ctx context.Context, _ runtimemanager.Status) runtimemanager.Status {
	close(f.started)
	select {
	case <-f.release:
	case <-ctx.Done():
	}
	return f.result
}

func runtimePluginForTest(t *testing.T) *DockerPlugin {
	t.Helper()
	return &DockerPlugin{
		cfg:    &dockerconfig.Config{BaseConfig: lifecycle.BaseConfig{StateDir: t.TempDir()}},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func installedRunsc(state runtimemanager.State, reason string, checkedAt time.Time) runtimemanager.Status {
	return runtimemanager.Status{
		State: state, ReasonCode: reason, InstalledVersion: "release-20260810.0",
		TargetVersion: runtimemanager.RunscVersion, CheckedAt: checkedAt,
	}
}

func newFakeRuntimeVerifier(result runtimemanager.Status) *fakeRuntimeVerifier {
	return &fakeRuntimeVerifier{
		pending: installedRunsc(runtimemanager.StateUnknown, "verification_pending", time.Now()),
		verify:  true,
		result:  result,
		release: make(chan struct{}),
		started: make(chan struct{}),
	}
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// TestStartupDoesNotWaitForTheSecureRuntimeSmokeTest is N-9: the smoke test
// held the daemon's Gateway connection and relay registrations back ~8 s on
// every restart of a node with Secure Runtime installed.
func TestStartupDoesNotWaitForTheSecureRuntimeSmokeTest(t *testing.T) {
	plugin := runtimePluginForTest(t)
	verifier := newFakeRuntimeVerifier(installedRunsc(runtimemanager.StateHealthy, "smoke_test_passed", time.Now()))

	started := time.Now()
	done := plugin.startRuntimeVerification(context.Background(), verifier)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("start-up waited %s for the smoke test", elapsed)
	}
	waitClosed(t, verifier.started, "the background smoke test")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateUnknown || got.ReasonCode != "verification_pending" {
		t.Fatalf("status while verifying without an earlier result = %+v", got)
	}

	close(verifier.release)
	waitClosed(t, done, "the verification")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateHealthy {
		t.Fatalf("status after verification = %+v", got)
	}
	if kept, ok := plugin.loadVerifiedRuntimeStatus(); !ok || kept.State != runtimemanager.StateHealthy {
		t.Fatalf("verified status kept for the next start = %+v, %v", kept, ok)
	}
}

// TestStartupReportsTheLastVerifiedResultWhileVerifying: a runtime verified
// healthy before the restart stays usable (hosting readiness, secure
// workloads) while it is verified again; a failed re-verification wins.
func TestStartupReportsTheLastVerifiedResultWhileVerifying(t *testing.T) {
	plugin := runtimePluginForTest(t)
	lastVerified := installedRunsc(runtimemanager.StateHealthy, "smoke_test_passed", time.Now().Add(-time.Hour).UTC())
	plugin.persistVerifiedRuntimeStatus(lastVerified)
	verifier := newFakeRuntimeVerifier(installedRunsc(runtimemanager.StateFailed, "smoke_test_failed", time.Now()))

	done := plugin.startRuntimeVerification(context.Background(), verifier)
	waitClosed(t, verifier.started, "the background smoke test")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateHealthy || !got.CheckedAt.Equal(lastVerified.CheckedAt) {
		t.Fatalf("provisional status = %+v, want the last verified result", got)
	}

	close(verifier.release)
	waitClosed(t, done, "the verification")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateFailed {
		t.Fatalf("status after a failed verification = %+v", got)
	}
	if kept, _ := plugin.loadVerifiedRuntimeStatus(); kept.State != runtimemanager.StateFailed {
		t.Fatalf("kept status = %+v", kept)
	}
}

func TestStartupIgnoresAVerifiedResultForAnotherRunscVersion(t *testing.T) {
	plugin := runtimePluginForTest(t)
	previous := installedRunsc(runtimemanager.StateHealthy, "smoke_test_passed", time.Now().Add(-time.Hour))
	previous.InstalledVersion = "release-20250101.0"
	plugin.persistVerifiedRuntimeStatus(previous)
	verifier := newFakeRuntimeVerifier(installedRunsc(runtimemanager.StateHealthy, "smoke_test_passed", time.Now()))

	done := plugin.startRuntimeVerification(context.Background(), verifier)
	waitClosed(t, verifier.started, "the background smoke test")
	if got := plugin.getRuntimeStatus(); got.ReasonCode != "verification_pending" {
		t.Fatalf("status = %+v, want pending for a different runsc", got)
	}
	close(verifier.release)
	waitClosed(t, done, "the verification")
}

// TestStartupVerificationNeverOverwritesANewerStatus: an install started
// meanwhile owns the status.
func TestStartupVerificationNeverOverwritesANewerStatus(t *testing.T) {
	plugin := runtimePluginForTest(t)
	verifier := newFakeRuntimeVerifier(installedRunsc(runtimemanager.StateFailed, "smoke_test_failed", time.Now()))

	done := plugin.startRuntimeVerification(context.Background(), verifier)
	waitClosed(t, verifier.started, "the background smoke test")
	plugin.setRuntimeStatus(runtimemanager.Status{State: runtimemanager.StateInstalling, CheckedAt: time.Now()})
	close(verifier.release)
	waitClosed(t, done, "the verification")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateInstalling {
		t.Fatalf("status = %+v, the install's status must stay", got)
	}
}

func TestStartupReportsANodeWithoutSecureRuntimeAtOnce(t *testing.T) {
	plugin := runtimePluginForTest(t)
	verifier := &fakeRuntimeVerifier{pending: runtimemanager.Status{State: runtimemanager.StateInstallable, ReasonCode: "installation_available"}}
	done := plugin.startRuntimeVerification(context.Background(), verifier)
	waitClosed(t, done, "the status")
	if got := plugin.getRuntimeStatus(); got.State != runtimemanager.StateInstallable {
		t.Fatalf("status = %+v", got)
	}
}
