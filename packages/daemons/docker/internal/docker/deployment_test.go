package docker

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/wiolett-industries/gateway/daemon-shared/gpu"
)

type failingGPUInventory struct{ err error }

func (inventory failingGPUInventory) Collect(context.Context) []gpu.Device { return nil }

func (inventory failingGPUInventory) Resolve(context.Context, []string) ([]gpu.Device, error) {
	return nil, inventory.err
}

func TestApplyDeploymentRuntimeFromFormValues(t *testing.T) {
	hostCfg := &container.HostConfig{}

	applyDeploymentRuntime(hostCfg, deploymentDesiredConfig{
		RestartPolicy: "on-failure",
		Runtime: map[string]any{
			"maxRetries": "3",
			"memoryMB":   "128",
			"memSwapMB":  "256",
			"cpuCount":   "0.5",
			"cpuShares":  "512",
			"pidsLimit":  "64",
		},
	})

	if hostCfg.RestartPolicy.Name != "on-failure" {
		t.Fatalf("restart policy = %q", hostCfg.RestartPolicy.Name)
	}
	if hostCfg.RestartPolicy.MaximumRetryCount != 3 {
		t.Fatalf("max retries = %d", hostCfg.RestartPolicy.MaximumRetryCount)
	}
	if hostCfg.Memory != 128*1048576 {
		t.Fatalf("memory = %d", hostCfg.Memory)
	}
	if hostCfg.MemorySwap != (128+256)*1048576 {
		t.Fatalf("memory swap = %d", hostCfg.MemorySwap)
	}
	if hostCfg.NanoCPUs != 500000000 {
		t.Fatalf("nano cpus = %d", hostCfg.NanoCPUs)
	}
	if hostCfg.CPUShares != 512 {
		t.Fatalf("cpu shares = %d", hostCfg.CPUShares)
	}
	if hostCfg.PidsLimit == nil || *hostCfg.PidsLimit != 64 {
		t.Fatalf("pids limit = %v", hostCfg.PidsLimit)
	}
}

func TestApplyDeploymentRuntimeFromNormalizedValues(t *testing.T) {
	hostCfg := &container.HostConfig{}

	applyDeploymentRuntime(hostCfg, deploymentDesiredConfig{
		Runtime: map[string]any{
			"restartPolicy": "always",
			"memoryLimit":   float64(67108864),
			"memorySwap":    float64(-1),
			"nanoCPUs":      float64(250000000),
		},
	})

	if hostCfg.RestartPolicy.Name != "always" {
		t.Fatalf("restart policy = %q", hostCfg.RestartPolicy.Name)
	}
	if hostCfg.Memory != 67108864 {
		t.Fatalf("memory = %d", hostCfg.Memory)
	}
	if hostCfg.MemorySwap != -1 {
		t.Fatalf("memory swap = %d", hostCfg.MemorySwap)
	}
	if hostCfg.NanoCPUs != 250000000 {
		t.Fatalf("nano cpus = %d", hostCfg.NanoCPUs)
	}
}

func TestDeployDeploymentSlotValidatesGPUBeforeReplacingTarget(t *testing.T) {
	resolveErr := errors.New("selected GPU disappeared")
	client := &Client{gpuInventory: failingGPUInventory{err: resolveErr}}
	_, err := client.DeployDeploymentSlot(context.Background(), deploymentCommandPayload{
		ToSlot: "green",
		Deployment: deploymentSnapshot{
			ID:          "deployment-1",
			NetworkName: "deployment-net",
			Slots: []struct {
				Slot          string `json:"slot"`
				ContainerName string `json:"containerName"`
			}{{Slot: "green", ContainerName: "deployment-green"}},
		},
		DesiredConfig: deploymentDesiredConfig{
			Image: "example:latest",
			GPU:   &GPUConfig{DeviceIDs: []string{"nvidia:GPU-missing"}},
		},
	})
	if !errors.Is(err, resolveErr) {
		t.Fatalf("deploy error = %v, want GPU validation error", err)
	}
}

func TestSwitchDeploymentValidatesGPUBeforeReplacingTarget(t *testing.T) {
	resolveErr := errors.New("selected GPU disappeared")
	client := &Client{gpuInventory: failingGPUInventory{err: resolveErr}}
	_, err := client.SwitchDeployment(context.Background(), deploymentCommandPayload{
		ActiveSlot: "blue",
		Deployment: deploymentSnapshot{
			ID:          "deployment-1",
			NetworkName: "deployment-net",
			Slots: []struct {
				Slot          string `json:"slot"`
				ContainerName string `json:"containerName"`
			}{{Slot: "blue", ContainerName: "deployment-blue"}},
		},
		DesiredConfig: deploymentDesiredConfig{
			Image: "example:latest",
			GPU:   &GPUConfig{DeviceIDs: []string{"nvidia:GPU-missing"}},
		},
	})
	if !errors.Is(err, resolveErr) {
		t.Fatalf("switch error = %v, want GPU validation error", err)
	}
}

func TestDeploymentRemovalContainerMatchesAvailabilityOwnership(t *testing.T) {
	dep := deploymentSnapshot{
		ID:          "deployment-1",
		RouterImage: "nginx:alpine",
		DesiredConfig: deploymentDesiredConfig{
			Image: "registry/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Labels: map[string]string{
				availabilityPolicyLabel:          "policy-1",
				availabilityPlacementLabel:       "placement-1",
				availabilityGenerationLabel:      "9",
				availabilitySpecFingerprintLabel: "fingerprint",
			},
		},
	}
	app := ContainerInfo{
		Name:  "deployment-blue",
		Image: dep.DesiredConfig.Image,
		Labels: map[string]string{
			deploymentIDLabel:                dep.ID,
			deploymentManagedLabel:           "true",
			deploymentRoleLabel:              "app",
			deploymentSlotLabel:              "blue",
			availabilityPolicyLabel:          "policy-1",
			availabilityPlacementLabel:       "placement-1",
			availabilityGenerationLabel:      "8",
			availabilitySpecFingerprintLabel: "fingerprint",
		},
	}
	if !deploymentRemovalContainerMatches(app, dep, "app", "blue", false) {
		t.Fatal("owned stale-generation app container should be removable")
	}
	changed := app
	changed.Image = "registry/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	changed.Labels = map[string]string{}
	for key, value := range app.Labels {
		changed.Labels[key] = value
	}
	changed.Labels[availabilitySpecFingerprintLabel] = "old-fingerprint"
	if !deploymentRemovalContainerMatches(changed, dep, "app", "blue", false) {
		t.Fatal("owned stale Availability runtime should remain removable after an image rollout")
	}
	foreign := app
	foreign.Labels = map[string]string{}
	for key, value := range app.Labels {
		foreign.Labels[key] = value
	}
	foreign.Labels[availabilityPolicyLabel] = "foreign-policy"
	if deploymentRemovalContainerMatches(foreign, dep, "app", "blue", false) {
		t.Fatal("foreign Availability container must not be removable")
	}
	if !deploymentRemovalContainerMatches(foreign, dep, "app", "blue", true) {
		t.Fatal("forced cleanup should recover an exact managed deployment identity after Availability adoption")
	}
	single := dep
	single.DesiredConfig.Labels = map[string]string{}
	if !deploymentRemovalContainerMatches(app, single, "app", "blue", false) {
		t.Fatal("single-node cleanup should accept residual Availability identity for the same managed deployment")
	}
	legacy := app
	legacy.Labels = map[string]string{
		deploymentIDLabel:      dep.ID,
		deploymentManagedLabel: "true",
		deploymentRoleLabel:    "app",
		deploymentSlotLabel:    "blue",
	}
	if !deploymentRemovalContainerMatches(legacy, dep, "app", "blue", false) {
		t.Fatal("fully matched legacy managed deployment container should be removable")
	}
	legacy.Image = "registry/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if !deploymentRemovalContainerMatches(legacy, dep, "app", "blue", false) {
		t.Fatal("labels prove ownership of a managed deployment container whatever image it runs")
	}
	if !deploymentRemovalContainerMatches(legacy, dep, "app", "blue", true) {
		t.Fatal("forced cleanup should recover an exact managed deployment identity after a partial rollout")
	}
	otherSlot := legacy
	if deploymentRemovalContainerMatches(otherSlot, dep, "app", "green", false) {
		t.Fatal("a container labelled for another slot must not match")
	}
	otherDeployment := legacy
	otherDeployment.Labels = map[string]string{
		deploymentIDLabel:      "deployment-2",
		deploymentManagedLabel: "true",
		deploymentRoleLabel:    "app",
		deploymentSlotLabel:    "blue",
	}
	if deploymentRemovalContainerMatches(otherDeployment, dep, "app", "blue", false) {
		t.Fatal("a container of another deployment must not match")
	}
	unmanaged := legacy
	unmanaged.Labels = map[string]string{deploymentIDLabel: dep.ID, deploymentRoleLabel: "app", deploymentSlotLabel: "blue"}
	if deploymentRemovalContainerMatches(unmanaged, dep, "app", "blue", false) {
		t.Fatal("a container without the managed label must not match")
	}
}

// TestRemoveDeploymentAfterImageChange reproduces create (v1) → deploy (v2) →
// delete: the standby slot still runs v1 and the router a differently
// spelled nginx image.
func TestRemoveDeploymentAfterImageChange(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Image: "registry.example/app:v1", Labels: deploymentLabels("app", "blue")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Image: "registry.example/app:v2", Running: true, Labels: deploymentLabels("app", "green")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-router", Image: "docker.io/library/nginx:alpine", Running: true, Labels: deploymentLabels("router", "")})
	unrelated := engine.addContainer(&fakeContainer{Name: "unrelated", Image: "registry.example/app:v1"})

	if err := client.RemoveDeployment(context.Background(), deploymentCommandPayload{Deployment: testDeploymentSnapshot("green")}); err != nil {
		t.Fatalf("remove deployment: %v", err)
	}
	for _, name := range []string{"gwdep-dep-1-blue", "gwdep-dep-1-green", "gwdep-dep-1-router"} {
		if engine.byName(name) != nil {
			t.Fatalf("%s was not removed", name)
		}
	}
	if engine.byName("unrelated") != unrelated {
		t.Fatal("an unrelated container was removed")
	}
}

func TestRemoveDeploymentRefusesUnownedContainer(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Image: "registry.example/app:v2", Labels: deploymentLabels("app", "blue")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Image: "registry.example/app:v2"})

	err := client.RemoveDeployment(context.Background(), deploymentCommandPayload{Deployment: testDeploymentSnapshot("blue")})
	if err == nil || !strings.Contains(err.Error(), "ownership does not match") {
		t.Fatalf("remove error = %v, want an ownership error", err)
	}
	if engine.byName("gwdep-dep-1-blue") == nil || engine.byName("gwdep-dep-1-green") == nil {
		t.Fatal("nothing may be removed when one target is not owned")
	}
}

// TestCreateDeploymentReplacesOwnedLeftovers retries a create whose first
// attempt failed after creating the blue slot and the router.
func TestCreateDeploymentReplacesOwnedLeftovers(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	leftoverBlue := engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Image: "registry.example/app:v2", Running: true, Labels: deploymentLabels("app", "blue")})
	leftoverRouter := engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-router", Image: "nginx:alpine", Labels: deploymentLabels("router", "")})
	unrelated := engine.addContainer(&fakeContainer{Name: "unrelated", Image: "registry.example/other:v1", Running: true})

	_, err := client.CreateDeployment(context.Background(), testCreatePayload())
	// The fake engine gives containers no address, so readiness is the first
	// step that can fail; anything earlier (a name conflict) is the bug.
	if err == nil || !strings.Contains(err.Error(), "deployment readiness timed out") {
		t.Fatalf("create error = %v, want only the readiness timeout of the fake engine", err)
	}
	for _, name := range []string{"gwdep-dep-1-blue", "gwdep-dep-1-green", "gwdep-dep-1-router"} {
		if engine.byName(name) == nil {
			t.Fatalf("%s was not created", name)
		}
	}
	if engine.byName("gwdep-dep-1-blue").ID == leftoverBlue.ID || engine.byName("gwdep-dep-1-router").ID == leftoverRouter.ID {
		t.Fatal("leftover containers were not replaced")
	}
	if engine.byName("unrelated") != unrelated {
		t.Fatal("an unrelated container was touched")
	}
}

func TestCreateDeploymentRefusesUnownedNameCollision(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	leftover := engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Labels: deploymentLabels("app", "blue")})
	foreign := engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Image: "someone/else:latest", Labels: map[string]string{deploymentIDLabel: "dep-1"}})

	_, err := client.CreateDeployment(context.Background(), testCreatePayload())
	if err == nil || !strings.Contains(err.Error(), `"gwdep-dep-1-green" is already used by a container that is not owned by deployment dep-1`) {
		t.Fatalf("create error = %v, want a name collision error", err)
	}
	if engine.byName("gwdep-dep-1-green") != foreign || engine.byName("gwdep-dep-1-blue") != leftover {
		t.Fatal("nothing may be removed when a target name is held by an unowned container")
	}
	if engine.countCalls("POST /containers/create") != 0 {
		t.Fatal("no container may be created after a name collision")
	}
}

func testCreatePayload() deploymentCommandPayload {
	return deploymentCommandPayload{
		DeploymentID: "dep-1",
		ActiveSlot:   "blue",
		RouterName:   "gwdep-dep-1-router",
		RouterImage:  "nginx:alpine",
		NetworkName:  "gwdep-dep-1",
		Slots:        map[string]string{"blue": "gwdep-dep-1-blue", "green": "gwdep-dep-1-green"},
		Routes:       testDeploymentRoutes,
		Health:       deploymentHealthConfig{DeployTimeoutSeconds: 1, IntervalSeconds: 1},
		DesiredConfig: deploymentDesiredConfig{
			Image: "registry.example/app:v2",
		},
	}
}
