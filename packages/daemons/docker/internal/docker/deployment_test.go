package docker

import (
	"context"
	"errors"
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
	if deploymentRemovalContainerMatches(legacy, dep, "app", "blue", false) {
		t.Fatal("legacy image mismatch should require an explicitly forced owned-runtime cleanup")
	}
	if !deploymentRemovalContainerMatches(legacy, dep, "app", "blue", true) {
		t.Fatal("forced cleanup should recover an exact managed deployment identity after a partial rollout")
	}
}
