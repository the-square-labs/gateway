package docker

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	dockerconfig "github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"google.golang.org/protobuf/proto"
)

func availabilityCommand(action string, generation uint64, idempotencyKey, operationID, configJSON string) *pb.DockerAvailabilityCommand {
	return &pb.DockerAvailabilityCommand{
		Action:         action,
		PolicyId:       "policy-1",
		PlacementId:    "placement-1",
		Generation:     generation,
		OperationId:    operationID,
		IdempotencyKey: idempotencyKey,
		ResourceKind:   "container",
		ResourceId:     "resource-1",
		ConfigJson:     configJSON,
	}
}

func availabilityGatewayCommand(command *pb.DockerAvailabilityCommand) *pb.GatewayCommand {
	return &pb.GatewayCommand{
		CommandId: "command-1",
		Payload: &pb.GatewayCommand_DockerAvailability{
			DockerAvailability: command,
		},
	}
}

func decodeAvailabilityDetail(t *testing.T, detail string) availabilityPlacementDetail {
	t.Helper()
	var state availabilityPlacementDetail
	if err := json.Unmarshal([]byte(detail), &state); err != nil {
		t.Fatalf("decode availability detail: %v; detail=%s", err, detail)
	}
	return state
}

func availabilityManagerForTest(t *testing.T) *availabilityManager {
	t.Helper()
	manager, err := newAvailabilityManager(t.TempDir())
	if err != nil {
		t.Fatalf("new availability manager: %v", err)
	}
	return manager
}

func availabilityPlacementForTest(manager *availabilityManager, policyID, placementID string) (availabilityPlacement, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	placement, ok := manager.state.Placements[availabilityPlacementKey(policyID, placementID)]
	return placement, ok
}

func availabilityPluginForTest(t *testing.T) *DockerPlugin {
	t.Helper()
	manager := availabilityManagerForTest(t)
	return &DockerPlugin{
		cfg: &dockerconfig.Config{
			BaseConfig: lifecycle.BaseConfig{StateDir: t.TempDir()},
		},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		availability: manager,
	}
}

func TestAvailabilityStatePersistsAcrossManagerRecreation(t *testing.T) {
	stateDir := t.TempDir()
	first, err := newAvailabilityManager(stateDir)
	if err != nil {
		t.Fatalf("new first availability manager: %v", err)
	}

	preparedDetail, err := first.apply(availabilityCommand(
		availabilityActionPrepare,
		7,
		"prepare-7",
		"operation-prepare",
		`{"runtime_id":"runtime-1","runtimeIdentity":{"containerId":"container-1","containerName":"resource-1","env":{"API_TOKEN":"plaintext-secret"}},"status":"prepared","runtime":{"id":"container-1","state":"created"},"env":{"API_TOKEN":"plaintext-secret"},"password":"super-secret"}`,
	))
	if err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}
	prepared := decodeAvailabilityDetail(t, preparedDetail)
	if prepared.HighestGeneration != 7 || prepared.LifecycleState != availabilityLifecyclePrepared {
		t.Fatalf("unexpected prepared detail: %#v", prepared)
	}
	if prepared.RuntimeMetadata["runtime_id"] != "runtime-1" {
		t.Fatalf("runtime identity was not retained: %#v", prepared.RuntimeMetadata)
	}
	if prepared.RuntimeIdentity["containerId"] != "container-1" || prepared.RuntimeIdentity["containerName"] != "resource-1" {
		t.Fatalf("backend-compatible runtime identity was not retained: %#v", prepared.RuntimeIdentity)
	}
	runtimeMetadata, ok := prepared.RuntimeMetadata["runtime"].(map[string]any)
	if !ok || runtimeMetadata["state"] != "created" {
		t.Fatalf("nested runtime metadata was not retained: %#v", prepared.RuntimeMetadata)
	}

	persisted, err := os.ReadFile(first.statePath)
	if err != nil {
		t.Fatalf("read persisted availability state: %v", err)
	}
	for _, forbidden := range []string{"plaintext-secret", "API_TOKEN", "super-secret", "password", "env"} {
		if strings.Contains(string(persisted), forbidden) {
			t.Fatalf("persisted availability state leaked %q: %s", forbidden, persisted)
		}
	}

	second, err := newAvailabilityManager(stateDir)
	if err != nil {
		t.Fatalf("recreate availability manager: %v", err)
	}
	inspectedDetail, err := second.apply(availabilityCommand(availabilityActionInspect, 7, "inspect-7", "", ""))
	if err != nil {
		t.Fatalf("inspect persisted availability placement: %v", err)
	}
	inspected := decodeAvailabilityDetail(t, inspectedDetail)
	if inspected.PolicyID != "policy-1" || inspected.PlacementID != "placement-1" || inspected.OperationID != "operation-prepare" {
		t.Fatalf("persisted identity or operation was lost: %#v", inspected)
	}

	activatedDetail, err := second.apply(availabilityCommand(
		availabilityActionActivate,
		7,
		"activate-7",
		"operation-activate",
		`{"runtime_id":"runtime-1","health":"healthy"}`,
	))
	if err != nil {
		t.Fatalf("activate persisted availability placement: %v", err)
	}
	activated := decodeAvailabilityDetail(t, activatedDetail)
	if activated.LifecycleState != availabilityLifecycleActive || activated.LastIdempotencyKey != "activate-7" {
		t.Fatalf("unexpected activated detail: %#v", activated)
	}
}

func TestAvailabilityRejectsStaleGeneration(t *testing.T) {
	manager := availabilityManagerForTest(t)
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 5, "prepare-5", "operation-5", "")); err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionActivate, 5, "activate-5", "operation-5-active", "")); err != nil {
		t.Fatalf("activate availability placement: %v", err)
	}

	_, err := manager.apply(availabilityCommand(availabilityActionDrain, 4, "drain-4", "operation-4", ""))
	if err == nil || !strings.Contains(err.Error(), "stale availability generation") || !strings.Contains(err.Error(), "below persisted highest generation 5") {
		t.Fatalf("stale generation error = %v", err)
	}
	placement, ok := availabilityPlacementForTest(manager, "policy-1", "placement-1")
	if !ok || placement.HighestGeneration != 5 || placement.LifecycleState != availabilityLifecycleActive {
		t.Fatalf("stale command changed persisted placement: %#v, exists=%t", placement, ok)
	}
}

func TestAvailabilityIdempotentReplayReturnsPriorResult(t *testing.T) {
	manager := availabilityManagerForTest(t)
	original, err := manager.apply(availabilityCommand(
		availabilityActionPrepare,
		3,
		"same-key",
		"operation-prepare",
		`{"status":"prepared"}`,
	))
	if err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}

	// The replay has a different action and malformed config, but the same
	// generation/key must return the durable result without applying anything.
	replay, err := manager.apply(availabilityCommand(
		availabilityActionActivate,
		3,
		"same-key",
		"operation-replay",
		"not-json",
	))
	if err != nil {
		t.Fatalf("idempotent replay: %v", err)
	}
	if replay != original {
		t.Fatalf("idempotent replay detail changed: original=%s replay=%s", original, replay)
	}
	placement, ok := availabilityPlacementForTest(manager, "policy-1", "placement-1")
	if !ok || placement.LifecycleState != availabilityLifecyclePrepared || placement.OperationID != "operation-prepare" {
		t.Fatalf("idempotent replay reapplied command: %#v, exists=%t", placement, ok)
	}

	advanced, err := manager.apply(availabilityCommand(availabilityActionActivate, 3, "new-key", "operation-activate", ""))
	if err != nil {
		t.Fatalf("same generation with a new key should advance valid lifecycle: %v", err)
	}
	if decodeAvailabilityDetail(t, advanced).LifecycleState != availabilityLifecycleActive {
		t.Fatalf("new idempotency key did not advance lifecycle: %s", advanced)
	}
	conflicting := availabilityCommand(availabilityActionActivate, 3, "same-key", "operation-conflict", "")
	conflicting.ResourceId = "resource-2"
	if _, err := manager.apply(conflicting); err == nil || !strings.Contains(err.Error(), "resource identity conflicts") {
		t.Fatalf("resource identity conflict was not rejected: %v", err)
	}
}

func TestAvailabilityHigherGenerationSupersedesOlderState(t *testing.T) {
	manager := availabilityManagerForTest(t)
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare-1", "operation-1", `{"runtime_id":"old-runtime","status":"prepared"}`)); err != nil {
		t.Fatalf("prepare first availability generation: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionActivate, 1, "activate-1", "operation-activate-1", "")); err != nil {
		t.Fatalf("activate first availability generation: %v", err)
	}

	secondDetail, err := manager.apply(availabilityCommand(availabilityActionPrepare, 2, "prepare-2", "operation-2", `{"runtime_id":"new-runtime","status":"prepared"}`))
	if err != nil {
		t.Fatalf("prepare newer availability generation: %v", err)
	}
	second := decodeAvailabilityDetail(t, secondDetail)
	if second.HighestGeneration != 2 || second.LifecycleState != availabilityLifecyclePrepared || second.LastIdempotencyKey != "prepare-2" || second.OperationID != "operation-2" {
		t.Fatalf("newer generation did not supersede older state: %#v", second)
	}
	if second.RuntimeMetadata["runtime_id"] != "new-runtime" {
		t.Fatalf("newer generation retained stale runtime metadata: %#v", second.RuntimeMetadata)
	}
}

func TestAvailabilityPrepareSupersedesStoppedOnHigherGeneration(t *testing.T) {
	manager := availabilityManagerForTest(t)
	if _, err := manager.apply(availabilityCommand(
		availabilityActionPrepare,
		1,
		"prepare-1",
		"operation-prepare-1",
		`{"runtime_id":"old-runtime","state":"prepared"}`,
	)); err != nil {
		t.Fatalf("prepare first availability generation: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(
		availabilityActionStop,
		1,
		"stop-1",
		"operation-stop-1",
		`{"runtime_id":"old-runtime","state":"stopped"}`,
	)); err != nil {
		t.Fatalf("stop first availability generation: %v", err)
	}

	preparedDetail, err := manager.apply(availabilityCommand(
		availabilityActionPrepare,
		2,
		"prepare-2",
		"operation-prepare-2",
		`{"runtime_id":"new-runtime","state":"prepared"}`,
	))
	if err != nil {
		t.Fatalf("prepare higher availability generation after stop: %v", err)
	}
	prepared := decodeAvailabilityDetail(t, preparedDetail)
	if prepared.HighestGeneration != 2 || prepared.LifecycleState != availabilityLifecyclePrepared {
		t.Fatalf("stopped placement was not superseded by higher generation: %#v", prepared)
	}
	if prepared.RuntimeMetadata["runtime_id"] != "new-runtime" {
		t.Fatalf("higher-generation prepare retained stopped runtime metadata: %#v", prepared.RuntimeMetadata)
	}

	if _, err := manager.apply(availabilityCommand(
		availabilityActionPrepare,
		1,
		"late-prepare-1",
		"operation-late-prepare-1",
		"",
	)); err == nil || !strings.Contains(err.Error(), "stale availability generation") {
		t.Fatalf("late prepare was not fenced after supersession: %v", err)
	}
}

func TestAvailabilityStopAcceptsSupportedLifecycleStates(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, manager *availabilityManager)
	}{
		{
			name: "prepared",
			setup: func(t *testing.T, manager *availabilityManager) {
				t.Helper()
				if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
					t.Fatalf("prepare: %v", err)
				}
			},
		},
		{
			name: "active",
			setup: func(t *testing.T, manager *availabilityManager) {
				t.Helper()
				if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
					t.Fatalf("prepare: %v", err)
				}
				if _, err := manager.apply(availabilityCommand(availabilityActionActivate, 1, "activate", "operation-activate", "")); err != nil {
					t.Fatalf("activate: %v", err)
				}
			},
		},
		{
			name: "single",
			setup: func(t *testing.T, manager *availabilityManager) {
				t.Helper()
				if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
					t.Fatalf("prepare: %v", err)
				}
				if _, err := manager.apply(availabilityCommand(availabilityActionAdoptSingle, 1, "adopt", "operation-adopt", "")); err != nil {
					t.Fatalf("adopt_single: %v", err)
				}
			},
		},
		{
			name: "draining",
			setup: func(t *testing.T, manager *availabilityManager) {
				t.Helper()
				if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
					t.Fatalf("prepare: %v", err)
				}
				if _, err := manager.apply(availabilityCommand(availabilityActionActivate, 1, "activate", "operation-activate", "")); err != nil {
					t.Fatalf("activate: %v", err)
				}
				if _, err := manager.apply(availabilityCommand(availabilityActionDrain, 1, "drain", "operation-drain", "")); err != nil {
					t.Fatalf("drain: %v", err)
				}
			},
		},
		{
			name: "stopped",
			setup: func(t *testing.T, manager *availabilityManager) {
				t.Helper()
				if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
					t.Fatalf("prepare: %v", err)
				}
				if _, err := manager.apply(availabilityCommand(availabilityActionStop, 1, "stop-first", "operation-stop-first", "")); err != nil {
					t.Fatalf("first stop: %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager := availabilityManagerForTest(t)
			test.setup(t, manager)
			detail, err := manager.apply(availabilityCommand(
				availabilityActionStop,
				1,
				"stop-final",
				"operation-stop-final",
				`{"runtime_id":"runtime-stopped","runtimeIdentity":{"containerId":"container-stopped"},"state":"stopped"}`,
			))
			if err != nil {
				t.Fatalf("stop from %s: %v", test.name, err)
			}
			stopped := decodeAvailabilityDetail(t, detail)
			if stopped.State != availabilityLifecycleStopped || stopped.LifecycleState != availabilityLifecycleStopped {
				t.Fatalf("stop from %s returned unexpected state: %#v", test.name, stopped)
			}
			if stopped.RuntimeMetadata["runtime_id"] != "runtime-stopped" {
				t.Fatalf("stop from %s did not retain config runtime metadata: %#v", test.name, stopped.RuntimeMetadata)
			}
			if stopped.RuntimeIdentity["containerId"] != "container-stopped" {
				t.Fatalf("stop from %s did not expose config runtime identity: %#v", test.name, stopped.RuntimeIdentity)
			}
		})
	}
}

func TestAvailabilityStopIsIdempotentAndInspectReportsStopped(t *testing.T) {
	manager := availabilityManagerForTest(t)
	if _, err := manager.apply(availabilityCommand(
		availabilityActionPrepare,
		4,
		"prepare-4",
		"operation-prepare-4",
		`{"runtime_id":"runtime-4","state":"prepared"}`,
	)); err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}
	stop := availabilityCommand(
		availabilityActionStop,
		4,
		"stop-4",
		"operation-stop-4",
		`{"runtime_id":"runtime-4","runtimeIdentity":{"containerId":"container-4"},"state":"stopped"}`,
	)
	first, err := manager.apply(stop)
	if err != nil {
		t.Fatalf("stop availability placement: %v", err)
	}
	replayCommand := proto.Clone(stop).(*pb.DockerAvailabilityCommand)
	replayCommand.Action = availabilityActionActivate
	replayCommand.ConfigJson = "not-json"
	replay, err := manager.apply(replayCommand)
	if err != nil {
		t.Fatalf("replay stop availability placement: %v", err)
	}
	if replay != first {
		t.Fatalf("idempotent stop replay changed result: first=%s replay=%s", first, replay)
	}

	inspectedDetail, err := manager.apply(availabilityCommand(availabilityActionInspect, 4, "inspect-4", "", ""))
	if err != nil {
		t.Fatalf("inspect stopped availability placement: %v", err)
	}
	inspected := decodeAvailabilityDetail(t, inspectedDetail)
	if inspected.State != availabilityLifecycleStopped || inspected.LifecycleState != availabilityLifecycleStopped {
		t.Fatalf("inspect did not report stopped state: %#v", inspected)
	}
	if inspected.RuntimeIdentity["containerId"] != "container-4" {
		t.Fatalf("inspect lost stopped runtime identity: %#v", inspected.RuntimeIdentity)
	}
}

func TestAvailabilityRestartsStoppedPlacementWithoutChangingGenerationOrRuntime(t *testing.T) {
	for _, kind := range []string{"container", "deployment", "compose"} {
		t.Run(kind, func(t *testing.T) {
			stateDir := t.TempDir()
			manager, err := newAvailabilityManager(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			for index, action := range []string{availabilityActionPrepare, availabilityActionActivate, availabilityActionStop, availabilityActionActivate, availabilityActionStop, availabilityActionActivate} {
				// Reload persisted state before each action, as after a daemon restart.
				manager, err = newAvailabilityManager(stateDir)
				if err != nil {
					t.Fatal(err)
				}
				key := action + strings.Repeat("-", index+1)
				cmd := availabilityCommand(action, 4, key, "operation-"+key, `{"runtimeIdentity":{"containerId":"existing-runtime"}}`)
				cmd.ResourceKind = kind
				detail, err := manager.apply(cmd)
				if err != nil {
					t.Fatalf("%s after action %d: %v", action, index, err)
				}
				got := decodeAvailabilityDetail(t, detail)
				if got.Generation != 4 || got.RuntimeIdentity["containerId"] != "existing-runtime" {
					t.Fatalf("lifecycle replaced runtime or generation: %#v", got)
				}
				if action == availabilityActionActivate && got.State != availabilityLifecycleActive {
					t.Fatalf("start did not activate: %#v", got)
				}
				if replay, err := manager.apply(cmd); err != nil || replay != detail {
					t.Fatalf("replay changed lifecycle result: %v", err)
				}
			}
		})
	}
}

func TestAvailabilityValidatesLifecycleTransitionsAndActions(t *testing.T) {
	manager := availabilityManagerForTest(t)
	for _, action := range []string{availabilityActionActivate, availabilityActionDrain, availabilityActionStop} {
		if _, err := manager.apply(availabilityCommand(action, 1, action, "operation-"+action, "")); err == nil || !strings.Contains(err.Error(), "invalid availability lifecycle transition") {
			t.Fatalf("action %q unexpectedly succeeded or returned wrong error: %v", action, err)
		}
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-prepare", "")); err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionDrain, 1, "drain-before-active", "operation-drain", "")); err == nil || !strings.Contains(err.Error(), "prepared -> drain") {
		t.Fatalf("drain before activation was not rejected: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 2, "claim-next-generation", "operation-claim", `{"phase":"claimed"}`)); err != nil {
		t.Fatalf("claim next generation for cleanup: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionDrain, 2, "drain-claimed-generation", "operation-drain-claimed", "")); err != nil {
		t.Fatalf("drain claimed generation for cleanup: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionRemove, 2, "remove-claimed-generation", "operation-remove-claimed", "")); err != nil {
		t.Fatalf("remove claimed generation: %v", err)
	}

	manager = availabilityManagerForTest(t)
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 1, "prepare-active", "operation-prepare-active", "")); err != nil {
		t.Fatalf("prepare availability placement for active lifecycle: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionActivate, 1, "activate", "operation-activate", "")); err != nil {
		t.Fatalf("activate availability placement: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionDrain, 1, "drain", "operation-drain", "")); err != nil {
		t.Fatalf("drain active availability placement: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionRemove, 1, "remove", "operation-remove", "")); err != nil {
		t.Fatalf("remove draining availability placement: %v", err)
	}

	adopt := availabilityCommand(availabilityActionAdoptSingle, 2, "adopt", "operation-adopt", `{"runtime_id":"adopted-1","state":"running"}`)
	adopt.PlacementId = "placement-adopted"
	adoptDetail, err := manager.apply(adopt)
	if err != nil {
		t.Fatalf("adopt single availability placement: %v", err)
	}
	if got := decodeAvailabilityDetail(t, adoptDetail); got.LifecycleState != availabilityLifecycleSingle || got.State != availabilityLifecycleSingle {
		t.Fatalf("adopt_single did not activate placement: %#v", got)
	}
	if _, err := manager.apply(availabilityCommand("start", 3, "unknown", "operation-unknown", "")); err == nil || !strings.Contains(err.Error(), `unknown Docker availability action "start"`) {
		t.Fatalf("unknown action error = %v", err)
	}
}

func TestAvailabilityRemovePersistsTombstoneAcrossRestart(t *testing.T) {
	stateDir := t.TempDir()
	manager, err := newAvailabilityManager(stateDir)
	if err != nil {
		t.Fatalf("new availability manager: %v", err)
	}
	if _, err := manager.apply(availabilityCommand(availabilityActionPrepare, 8, "prepare-8", "operation-8", "")); err != nil {
		t.Fatalf("prepare availability placement: %v", err)
	}
	removedDetail, err := manager.apply(availabilityCommand(availabilityActionRemove, 8, "remove-8", "operation-remove", ""))
	if err != nil {
		t.Fatalf("remove availability placement: %v", err)
	}
	removed := decodeAvailabilityDetail(t, removedDetail)
	if !removed.Tombstone || removed.LifecycleState != availabilityLifecycleRemoved || removed.HighestGeneration != 8 {
		t.Fatalf("remove did not persist tombstone: %#v", removed)
	}

	recreated, err := newAvailabilityManager(stateDir)
	if err != nil {
		t.Fatalf("recreate availability manager: %v", err)
	}
	_, err = recreated.apply(availabilityCommand(availabilityActionPrepare, 7, "stale-prepare", "operation-stale", ""))
	if err == nil || !strings.Contains(err.Error(), "stale availability generation") {
		t.Fatalf("stale reconnect was not fenced by tombstone: %v", err)
	}
	_, err = recreated.apply(availabilityCommand(availabilityActionPrepare, 8, "different-key", "operation-replay", ""))
	if err == nil || !strings.Contains(err.Error(), "removed -> prepare") {
		t.Fatalf("same-generation tombstone was resurrected: %v", err)
	}
	persisted, err := os.ReadFile(recreated.statePath)
	if err != nil {
		t.Fatalf("read tombstone state: %v", err)
	}
	if !strings.Contains(string(persisted), `"tombstone": true`) {
		t.Fatalf("tombstone was not persisted: %s", persisted)
	}
}

func TestAvailabilityCapabilityAndCommandRoutingAreProfileScoped(t *testing.T) {
	generic := availabilityPluginForTest(t)
	if !containsCapability(generic.BuildRegisterMessage("node-1").Capabilities, dockerAvailabilityCapability) {
		t.Fatalf("generic Docker profile omitted availability capability: %v", generic.BuildRegisterMessage("node-1").Capabilities)
	}
	result := generic.HandleCommand(availabilityGatewayCommand(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-1", "")))
	if !result.Success || decodeAvailabilityDetail(t, result.Detail).LifecycleState != availabilityLifecyclePrepared {
		t.Fatalf("generic Docker availability command was not routed: %#v", result)
	}

	uninitialized := &DockerPlugin{cfg: &dockerconfig.Config{}}
	if containsCapability(uninitialized.BuildRegisterMessage("node-1").Capabilities, dockerAvailabilityCapability) {
		t.Fatal("uninitialized generic Docker profile advertised availability")
	}
	uninitializedResult := uninitialized.HandleCommand(availabilityGatewayCommand(availabilityCommand(availabilityActionInspect, 1, "inspect", "", "")))
	if uninitializedResult.Success || uninitializedResult.Error != "docker availability state manager is not initialized" {
		t.Fatalf("uninitialized generic command result = %#v", uninitializedResult)
	}

	for _, profile := range []struct {
		name  string
		mode  string
		error string
	}{
		{name: "builder", mode: "builder", error: "builder-profile daemon accepts only"},
		{name: "database", mode: "databases", error: "database-profile daemon accepts only"},
	} {
		plugin := &DockerPlugin{cfg: &dockerconfig.Config{Docker: dockerconfig.DockerConfig{Mode: profile.mode}}}
		if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, dockerAvailabilityCapability) {
			t.Fatalf("%s profile advertised availability", profile.name)
		}
		profileResult := plugin.HandleCommand(availabilityGatewayCommand(availabilityCommand(availabilityActionPrepare, 1, "prepare", "operation-1", "")))
		if profileResult.Success || !strings.Contains(profileResult.Error, profile.error) {
			t.Fatalf("%s profile availability command result = %#v", profile.name, profileResult)
		}
	}
}

func TestDockerPluginInitFailsWhenAvailabilityStateCannotInitialize(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state-file")
	if err := os.WriteFile(statePath, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("create invalid state path: %v", err)
	}
	plugin := NewDockerPlugin(&dockerconfig.Config{BaseConfig: lifecycle.BaseConfig{StateDir: statePath}})
	err := plugin.Init(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil || !strings.Contains(err.Error(), "initialize docker availability state") {
		t.Fatalf("Init error = %v", err)
	}
	if plugin.availability != nil {
		t.Fatal("availability manager remained set after failed initialization")
	}
}
