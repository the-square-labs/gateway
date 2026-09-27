package docker

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// hookedPluginForTest is a non-holder lease plugin whose Docker client runs
// the start hook, over the recording Docker fake.
func hookedPluginForTest(t *testing.T) (*DockerPlugin, *standbyFakeDocker) {
	t.Helper()
	plugin := leasePluginForTest(t)
	fake, dockerClient := newStandbyFakeDocker(t)
	dockerClient.beforeStart = plugin.lease.beforeStart
	plugin.client = dockerClient
	return plugin, fake
}

func TestStartHookRefusesEveryStartSiteWithoutTheLease(t *testing.T) {
	plugin, fake := hookedPluginForTest(t)
	ctx := context.Background()
	fake.labels["lease-c"] = map[string]string{availabilityPolicyLabel: "policy-1"}
	fake.labels["legacy-c"] = map[string]string{availabilityPolicyLabel: "legacy-policy"}

	if err := plugin.client.StartContainer(ctx, "lease-c"); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("container start: %v", err)
	}
	if err := plugin.client.RestartContainer(ctx, "lease-c", 10); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("container restart: %v", err)
	}
	if err := plugin.client.StartContainer(ctx, "missing"); err == nil {
		t.Fatal("an uninspectable container must fail closed")
	}
	desired := deploymentDesiredConfig{Image: "app:1", Labels: map[string]string{availabilityPolicyLabel: "policy-1"}}
	if _, err := plugin.client.createDeploymentSlot(ctx, "dep-1", "dep-1-net", "blue", "dep-1-blue", desired, true, nil); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("deployment slot start: %v", err)
	}
	recreated := &container.InspectResponse{
		ID: "old", Name: "/lease-app", Config: &container.Config{Image: "app:1", Labels: map[string]string{availabilityPolicyLabel: "policy-1"}},
		HostConfig: &container.HostConfig{},
	}
	if _, err := plugin.client.createContainerFromInspect(ctx, recreated, "app:2", nil, nil, true); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("recreate start: %v", err)
	}

	// Compose placement containers carry no availability label: they are
	// mapped by project name and started only through the hook.
	if _, err := plugin.availability.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: "policy-1", PlacementId: "p-shop", Generation: 1, IdempotencyKey: "shop:standby",
		ResourceKind: "compose", ResourceId: "project-shop", ConfigJson: `{"phase":"standby","runtimeIdentity":{"projectName":"shop"}}`,
	}); err != nil {
		t.Fatal(err)
	}
	fake.labels["svc-1"] = map[string]string{composeProjectLabel: "shop"}
	fake.listed = []map[string]any{{"Id": "svc-1", "State": "exited", "Labels": map[string]string{composeProjectLabel: "shop"}}}
	if err := plugin.startComposeProject("shop"); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("compose start: %v", err)
	}
	gate := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "start", ContainerId: "svc-1"}}}
	if err := plugin.leaseGate(gate); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("the dispatch gate must map compose containers by project: %v", err)
	}
	unknown := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "start", ContainerId: "missing"}}}
	if err := plugin.leaseGate(unknown); err == nil {
		t.Fatal("the dispatch gate must fail closed on inspect errors")
	}
	if len(fake.started) != 0 {
		t.Fatalf("nothing may start without the lease, started %v", fake.started)
	}

	if err := plugin.client.StartContainer(ctx, "legacy-c"); err != nil {
		t.Fatalf("a legacy container keeps starting: %v", err)
	}
	if len(fake.started) != 1 || fake.started[0] != "legacy-c" {
		t.Fatalf("started %v", fake.started)
	}
}

func TestLeaseModeComposeRunsWithNoStart(t *testing.T) {
	commands, err := composeSidecarCommands(composeRequest{action: "pull_apply", noStart: true})
	want := [][]string{{"pull"}, {"up", "--no-start", "--no-build", "--pull", "never"}}
	if err != nil || !reflect.DeepEqual(commands, want) {
		t.Fatalf("lease-mode pull_apply %v err %v", commands, err)
	}
	for _, action := range []string{"apply", "start", "restart"} {
		commands, err := composeSidecarCommands(composeRequest{action: action, noStart: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, command := range commands {
			if command[0] == "start" || command[0] == "restart" || (command[0] == "up" && command[1] != "--no-start") {
				t.Fatalf("lease-mode compose %s starts inside the sidecar: %v", action, commands)
			}
		}
	}
}
