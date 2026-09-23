package supervisor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
	"google.golang.org/grpc"
)

type fakeRelayAdmin struct {
	relayv1.RelayAdminClient
	keys           []string
	bootstrapErr   error
	bootstrapCalls int
	healthCalls    int
}

func (f *fakeRelayAdmin) GetHealth(context.Context, *relayv1.HealthRequest, ...grpc.CallOption) (*relayv1.HealthResponse, error) {
	f.healthCalls++
	return &relayv1.HealthResponse{
		BuildVersion: "relay-test", ProtocolMajor: 1, Readiness: len(f.keys) > 0,
		Capabilities: []string{relayPoolCapability}, PolicyKeyIds: append([]string(nil), f.keys...),
	}, nil
}

func (f *fakeRelayAdmin) BootstrapPolicyTrust(_ context.Context, request *relayv1.BootstrapPolicyTrustRequest, _ ...grpc.CallOption) (*relayv1.BootstrapPolicyTrustResponse, error) {
	f.bootstrapCalls++
	if f.bootstrapErr != nil {
		return nil, f.bootstrapErr
	}
	f.keys = append(f.keys, request.KeyId)
	return &relayv1.BootstrapPolicyTrustResponse{KeyId: request.KeyId}, nil
}

func pluginWithRunningWorker(t *testing.T, admin *fakeRelayAdmin) *Plugin {
	t.Helper()
	plugin := New(&config.Config{Worker: config.WorkerConfig{ServicePort: 9443}})
	plugin.cfg.StateDir = t.TempDir()
	// A started worker as ensureRunning sees it; no process is spawned.
	plugin.worker.process = &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}}
	plugin.worker.client = admin
	plugin.worker.state = &enrollmentState{PoolID: "system", InstanceID: "relay-1", PolicySigningKeyID: "enrollment-key"}
	return plugin
}

// The enrollment key ages out of relay trust about 30 days after the first
// rotation. A relay that already trusts newer keys must keep reporting its real
// state instead of failing a re-bootstrap and dropping out of the pool.
func TestCollectRuntimeSkipsBootstrapWhenRelayAlreadyTrustsKeys(t *testing.T) {
	admin := &fakeRelayAdmin{
		keys:         []string{"rotated-key"},
		bootstrapErr: errors.New("new policy signing keys require signed rotation"),
	}
	status := pluginWithRunningWorker(t, admin).collectRuntime(context.Background())
	if admin.bootstrapCalls != 0 {
		t.Fatalf("relay with policy trust was re-bootstrapped %d times", admin.bootstrapCalls)
	}
	if status.GetState() != "ready" || status.GetBuildVersion() != "relay-test" {
		t.Fatalf("unexpected runtime status: state=%q build=%q error=%q", status.GetState(), status.GetBuildVersion(), status.GetError())
	}
	if keys := status.GetPolicySigningKeyIds(); len(keys) != 1 || keys[0] != "rotated-key" {
		t.Fatalf("trusted policy keys were not reported: %v", keys)
	}
}

func TestCollectRuntimeReportsHealthWhenBootstrapFails(t *testing.T) {
	admin := &fakeRelayAdmin{bootstrapErr: errors.New("relay refused enrollment key")}
	status := pluginWithRunningWorker(t, admin).collectRuntime(context.Background())
	if admin.bootstrapCalls != 1 {
		t.Fatalf("relay without trust was bootstrapped %d times", admin.bootstrapCalls)
	}
	if status.GetState() != "synchronizing" || status.GetBuildVersion() != "relay-test" || status.GetProtocolMajor() != 1 {
		t.Fatalf("bootstrap failure hid relay health: state=%q build=%q", status.GetState(), status.GetBuildVersion())
	}
	if !strings.Contains(status.GetError(), "relay refused enrollment key") {
		t.Fatalf("bootstrap failure was not reported: %q", status.GetError())
	}
}

func TestCollectRuntimeBootstrapsRelayWithoutTrust(t *testing.T) {
	admin := &fakeRelayAdmin{}
	status := pluginWithRunningWorker(t, admin).collectRuntime(context.Background())
	if admin.bootstrapCalls != 1 {
		t.Fatalf("fresh relay was bootstrapped %d times", admin.bootstrapCalls)
	}
	if keys := status.GetPolicySigningKeyIds(); len(keys) != 1 || keys[0] != "enrollment-key" {
		t.Fatalf("status did not reflect the bootstrapped key: %v", keys)
	}
	if status.GetError() != "" {
		t.Fatalf("unexpected error after successful bootstrap: %q", status.GetError())
	}
}
