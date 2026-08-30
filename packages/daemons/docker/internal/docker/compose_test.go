package docker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"gopkg.in/yaml.v3"
)

type fakeComposeSidecar struct {
	mu      sync.Mutex
	calls   int
	started chan struct{}
	release chan struct{}
}

func (f *fakeComposeSidecar) run(ctx context.Context, _ composeRequest) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.started != nil {
		select {
		case f.started <- struct{}{}:
		default:
		}
	}
	if f.release != nil {
		select {
		case <-f.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (f *fakeComposeSidecar) cancelAll() {}

func (f *fakeComposeSidecar) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newTestComposeExecutor(sidecar composeSidecar) *composeExecutor {
	return &composeExecutor{
		sidecar:   sidecar,
		timeout:   time.Second,
		active:    make(map[string]*composeOperation),
		completed: make(map[string]composeOperationResult),
	}
}

func validComposeCommand(action, operationID string) *pb.DockerComposeCommand {
	command := &pb.DockerComposeCommand{
		Action: action, OperationId: operationID, ProjectId: "project-1", ProjectName: "example",
	}
	if action != "cancel" && action != "delete_volumes" {
		command.RevisionId = "revision-1"
		command.ConfigDigest = strings.Repeat("a", 64)
		command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n")
		command.NormalizedModelJson = "{}"
	}
	return command
}

func TestComposeExecutorDoesNotDoubleExecuteSameOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{}
	executor := newTestComposeExecutor(sidecar)
	command := validComposeCommand("apply", "operation-1")
	if _, err := executor.handle(command); err != nil {
		t.Fatalf("first operation: %v", err)
	}
	if _, err := executor.handle(command); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if got := sidecar.callCount(); got != 1 {
		t.Fatalf("sidecar calls = %d, want 1", got)
	}
}

func TestComposeExecutorRejectsConflictingActiveOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{started: make(chan struct{}, 1), release: make(chan struct{})}
	executor := newTestComposeExecutor(sidecar)
	firstDone := make(chan error, 1)
	go func() { _, err := executor.handle(validComposeCommand("apply", "operation-1")); firstDone <- err }()
	<-sidecar.started
	if _, err := executor.handle(validComposeCommand("apply", "operation-2")); err == nil || !strings.Contains(err.Error(), "conflicting") {
		t.Fatalf("conflicting operation error = %v", err)
	}
	close(sidecar.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first operation: %v", err)
	}
}

func TestComposeExecutorCancelTargetsMatchingOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{started: make(chan struct{}, 1), release: make(chan struct{})}
	executor := newTestComposeExecutor(sidecar)
	firstDone := make(chan error, 1)
	go func() { _, err := executor.handle(validComposeCommand("apply", "operation-1")); firstDone <- err }()
	<-sidecar.started
	if _, err := executor.handle(validComposeCommand("cancel", "operation-1")); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("first operation error = %v", err)
	}
	if _, err := executor.handle(validComposeCommand("cancel", "operation-2")); err == nil || !strings.Contains(err.Error(), "no active") {
		t.Fatalf("mismatched cancel error = %v", err)
	}
}

func TestComposePolicyRejectsBuildAndInjectsOwnershipLabels(t *testing.T) {
	command := validComposeCommand("apply", "operation-1")
	request, err := validateComposeCommand(command)
	if err != nil {
		t.Fatalf("validate accepted compose: %v", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		t.Fatalf("parse normalized yaml: %v", err)
	}
	services := document["services"].(map[string]any)
	labels := services["web"].(map[string]any)["labels"].(map[string]any)
	if labels["wiolett.gateway.compose.project-id"] != "project-1" {
		t.Fatalf("project ownership label = %#v", labels)
	}
	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    build: .\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "build") {
		t.Fatalf("build validation error = %v", err)
	}
}

func TestComposePolicyRejectsVariableInterpolationInVolumeSources(t *testing.T) {
	for _, composeYAML := range []string{
		`services:
  web:
    image: nginx:alpine
    volumes:
      - ${HOST_PATH}:/sock:ro
volumes:
  ${HOST_PATH}: {}
`,
		`services:
  web:
    image: nginx:alpine
    volumes:
      - type: volume
        source: ${HOST_PATH}
        target: /sock
volumes:
  ${HOST_PATH}: {}
`,
	} {
		command := validComposeCommand("apply", "operation-volume-interpolation")
		command.Variables = map[string]string{"HOST_PATH": "/var/run/docker.sock"}
		command.ComposeYaml = []byte(composeYAML)
		if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "host bind") {
			t.Fatalf("volume interpolation validation error = %v", err)
		}
	}
}

func TestComposePolicyAcceptsOrdinaryResourceLimitsAndRejectsInvalidValues(t *testing.T) {
	command := validComposeCommand("apply", "operation-resources")
	command.ComposeYaml = []byte(`services:
  web:
    image: nginx:alpine
    cpus: 1.5
    cpu_shares: 512
    mem_limit: 768M
    mem_reservation: 256M
    memswap_limit: 1G
    pids_limit: 128
`)
	if _, err := validateComposeCommand(command); err != nil {
		t.Fatalf("resource limits rejected: %v", err)
	}

	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    mem_limit: lots\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "mem_limit") {
		t.Fatalf("invalid resource limit error = %v", err)
	}

	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    deploy:\n      replicas: 2\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "deploy") {
		t.Fatalf("deploy validation error = %v", err)
	}
}

func TestComposePolicyMatchesBackendNameResourceAndLabelSubset(t *testing.T) {
	command := validComposeCommand("apply", "operation-parity")
	command.ComposeYaml = []byte(`name: example
services:
  web:
    image: nginx:alpine
    labels:
      - app=web
volumes:
  data:
    driver: local
    labels:
      tier: persistent
networks:
  app:
    driver: bridge
    labels:
      - tier=internal
`)
	request, err := validateComposeCommand(command)
	if err != nil {
		t.Fatalf("backend-supported compose subset rejected: %v", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		t.Fatalf("parse normalized yaml: %v", err)
	}
	labels := document["services"].(map[string]any)["web"].(map[string]any)["labels"].(map[string]any)
	if labels["app"] != "web" || labels["wiolett.gateway.compose.managed"] != "true" {
		t.Fatalf("normalized labels = %#v", labels)
	}

	command.ComposeYaml = []byte("name: another\nservices:\n  web:\n    image: nginx:alpine\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "project_name") {
		t.Fatalf("mismatched document name error = %v", err)
	}
}

func TestComposeSidecarCommandsPreservePullAndVolumesSemantics(t *testing.T) {
	apply, err := composeSidecarCommands(composeRequest{action: "apply"})
	if err != nil || len(apply) != 1 || strings.Join(apply[0], " ") != "up --detach --no-build --pull never" {
		t.Fatalf("apply commands = %#v, %v", apply, err)
	}
	pullApply, err := composeSidecarCommands(composeRequest{action: "pull_apply"})
	if err != nil || len(pullApply) != 2 || pullApply[0][0] != "pull" || strings.Join(pullApply[1], " ") != "up --detach --no-build --pull never" {
		t.Fatalf("pull_apply commands = %#v, %v", pullApply, err)
	}
	down, err := composeSidecarCommands(composeRequest{action: "down"})
	if err != nil || strings.Contains(strings.Join(down[0], " "), "--volumes") {
		t.Fatalf("down commands = %#v, %v", down, err)
	}
}

func TestComposeSidecarUsesExplicitBinaryEntrypoint(t *testing.T) {
	if composeSidecarEntrypoint != "/docker-compose" {
		t.Fatalf("compose sidecar entrypoint = %q", composeSidecarEntrypoint)
	}
}

func TestComposeExecutionErrorsAreRedacted(t *testing.T) {
	if got := redactComposeExecutionError(errors.New("token=secret")); got.Error() != "docker compose operation failed" {
		t.Fatalf("redacted error = %q", got.Error())
	}
	if got := redactComposeExecutionError(context.Canceled); got.Error() != "docker compose operation canceled" {
		t.Fatalf("cancellation error = %q", got.Error())
	}
}

func TestComposeCommandErrorReturnsOnlyAllowlistedDiagnostic(t *testing.T) {
	err := redactComposeExecutionError(&composeSidecarCommandError{
		detail: "Bind for 0.0.0.0:8080 failed: port is already allocated; token=super-secret",
	})
	if got := err.Error(); got != "Docker Compose could not publish a host port because it is already in use. Change the published port and create a new revision." {
		t.Fatalf("unexpected detailed compose error: %q", got)
	}
	if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "8080") {
		t.Fatalf("allowlisted compose error leaked raw detail: %q", err.Error())
	}

	generic := redactComposeExecutionError(&composeSidecarCommandError{
		detail: "multiline\nsecret value from user-authored yaml",
	})
	if got := generic.Error(); got != "docker compose operation failed" {
		t.Fatalf("unexpected generic compose error: %q", got)
	}
}

func TestComposeCapabilityRequiresInitializedExecutorAndGeneralProfile(t *testing.T) {
	plugin := &DockerPlugin{cfg: &config.Config{}}
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("compose capability advertised without an initialized executor")
	}
	plugin.composeExecutor = &composeExecutor{}
	if !containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("compose capability missing with an initialized executor")
	}
	plugin.cfg.Docker.Mode = "databases"
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("database profile advertised compose capability")
	}
	result := plugin.HandleCommand(&pb.GatewayCommand{CommandId: "command-1", Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: validComposeCommand("apply", "operation-1")}})
	if result.Success || !strings.Contains(result.Error, "database-profile") {
		t.Fatalf("database profile compose result = %#v", result)
	}
}

func containsCapability(capabilities []string, capability string) bool {
	for _, candidate := range capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}
