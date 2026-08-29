package docker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/distribution/reference"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

func (c *Client) UpdateContainer(ctx context.Context, id string, newTag string, envOverrides map[string]string, envRemovals []string, registryAuth string, expectedState string) error {
	requestedExpectedRunning, err := parseRecreateExpectedRunning(expectedState)
	if err != nil {
		return err
	}
	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect container: %w", err)
	}
	insp := inspResult.Container
	rollbackSnapshot, err := cloneInspectResponse(&insp)
	if err != nil {
		return fmt.Errorf("clone container for rollback: %w", err)
	}

	imageRef := containerRecreateImageReference(&insp)
	if imageRef == "" {
		return fmt.Errorf("could not determine image for container")
	}

	// Only talk to the registry when the requested image tag changes.
	if newTag != "" {
		updateReference := containerTagUpdateImageReference(&insp)
		if !strings.Contains(updateReference, ":") {
			updateReference += ":latest"
		}
		named, err := reference.ParseNormalizedNamed(updateReference)
		if err != nil {
			return fmt.Errorf("parse image reference: %w", err)
		}
		named = reference.TrimNamed(named)
		newRef, err := reference.WithTag(named, newTag)
		if err != nil {
			return fmt.Errorf("apply tag %q: %w", newTag, err)
		}
		imageRef = newRef.String()
		if insp.Config.Labels != nil {
			if _, imported := insp.Config.Labels[archiveImageReferenceLabel]; imported {
				insp.Config.Labels[archiveImageReferenceLabel] = imageRef
			}
		}

		pullOpts := client.ImagePullOptions{}
		if registryAuth != "" {
			pullOpts.RegistryAuth = registryAuth
		}

		pullResp, err := c.cli.ImagePull(ctx, imageRef, pullOpts)
		if err != nil {
			return fmt.Errorf("pull image: %w", err)
		}
		// Drain the pull response to complete the pull.
		_, _ = io.Copy(io.Discard, pullResp)
		pullResp.Close()
	}

	return c.recreateContainer(ctx, &insp, imageRef, envOverrides, envRemovals, rollbackSnapshot, requestedExpectedRunning)
}

// containerRecreateImageReference deliberately prefers Config.Image. Imported
// GWCA containers use an immutable image ID there, while their preserved source
// tag is only suitable for an explicit tag-changing update after a pull.
func containerRecreateImageReference(insp *container.InspectResponse) string {
	if insp != nil && insp.Config != nil {
		if imageReference := strings.TrimSpace(insp.Config.Image); imageReference != "" {
			return imageReference
		}
	}
	if insp == nil {
		return ""
	}
	return strings.TrimSpace(insp.Image)
}

func containerTagUpdateImageReference(insp *container.InspectResponse) string {
	if insp != nil && insp.Config != nil {
		if imageReference := configuredArchiveImageReference(insp.Config.Image, insp.Config.Labels); imageReference != "" {
			return imageReference
		}
	}
	return containerRecreateImageReference(insp)
}

// LiveUpdateContainer applies resource limits and restart policy to an existing container
// without recreating it. This uses Docker's ContainerUpdate API for running, restarting,
// and stopped containers.
func (c *Client) LiveUpdateContainer(ctx context.Context, id string, configJSON string) error {
	var params struct {
		RestartPolicy *string `json:"restartPolicy"`
		MaxRetries    *int    `json:"maxRetries"`
		MemoryLimit   *int64  `json:"memoryLimit"` // bytes
		MemorySwap    *int64  `json:"memorySwap"`  // bytes, -1 = unlimited
		NanoCPUs      *int64  `json:"nanoCPUs"`    // 1e9 = 1 CPU
		CpuShares     *int64  `json:"cpuShares"`
		PidsLimit     *int64  `json:"pidsLimit"` // 0 = unlimited
	}
	if err := json.Unmarshal([]byte(configJSON), &params); err != nil {
		return fmt.Errorf("parse live update params: %w", err)
	}

	opts := client.ContainerUpdateOptions{}

	// Restart policy
	if params.RestartPolicy != nil {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(*params.RestartPolicy)}
		if *params.RestartPolicy == "on-failure" && params.MaxRetries != nil {
			policy.MaximumRetryCount = *params.MaxRetries
		}
		opts.RestartPolicy = &policy
	}

	// Resource limits
	resources := container.Resources{}
	hasResources := false
	if params.MemoryLimit != nil {
		resources.Memory = *params.MemoryLimit
		if params.MemorySwap == nil {
			inspect, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
			if err != nil {
				return fmt.Errorf("inspect container before memory update: %w", err)
			}
			currentSwap := inspect.Container.HostConfig.MemorySwap
			switch {
			case *params.MemoryLimit <= 0:
				resources.MemorySwap = 0
			case currentSwap == -1 || currentSwap >= *params.MemoryLimit:
				resources.MemorySwap = currentSwap
			default:
				// Docker rejects a memory-only live update when the existing swap
				// limit is unset or lower than the new memory limit. Default to no
				// swap unless the container already has a compatible explicit limit.
				resources.MemorySwap = *params.MemoryLimit
			}
		}
		hasResources = true
	}
	if params.MemorySwap != nil {
		resources.MemorySwap = *params.MemorySwap
		hasResources = true
	}
	if params.NanoCPUs != nil {
		applyNanoCPULimit(&resources, *params.NanoCPUs)
		hasResources = true
	}
	if params.CpuShares != nil {
		resources.CPUShares = *params.CpuShares
		hasResources = true
	}
	if params.PidsLimit != nil {
		pids := *params.PidsLimit
		resources.PidsLimit = &pids
		hasResources = true
	}
	if hasResources {
		opts.Resources = &resources
	}

	_, err := c.cli.ContainerUpdate(ctx, id, opts)
	if err != nil {
		return fmt.Errorf("live update container: %w", err)
	}
	return nil
}

// RecreateWithConfig stops, removes, and recreates a container with new configuration
// overrides for ports, mounts, entrypoint, command, working directory, user, hostname, and labels.
func (c *Client) RecreateWithConfig(ctx context.Context, id string, configJSON string) error {
	var params struct {
		Image     string                 `json:"image"`
		Env       map[string]string      `json:"env"`
		RemoveEnv []string               `json:"removeEnv"`
		Ports     []containerPortMapping `json:"ports"`
		Mounts    []struct {
			HostPath      string `json:"hostPath"`
			ContainerPath string `json:"containerPath"`
			Name          string `json:"name"`
			ReadOnly      bool   `json:"readOnly"`
		} `json:"mounts"`
		Entrypoint     []string          `json:"entrypoint"`
		Command        []string          `json:"command"`
		WorkingDir     string            `json:"workingDir"`
		User           string            `json:"user"`
		Hostname       string            `json:"hostname"`
		Labels         map[string]string `json:"labels"`
		StopTimeout    *int              `json:"stopTimeout"`
		RestartPolicy  *string           `json:"restartPolicy"`
		MaxRetries     *int              `json:"maxRetries"`
		MemoryLimit    *int64            `json:"memoryLimit"`
		MemorySwap     *int64            `json:"memorySwap"`
		NanoCPUs       *int64            `json:"nanoCPUs"`
		CpuShares      *int64            `json:"cpuShares"`
		PidsLimit      *int64            `json:"pidsLimit"`
		GPU            *GPUConfig        `json:"gpu"`
		RuntimeProfile *string           `json:"runtimeProfile"`
		ExpectedState  string            `json:"expectedState"`
	}
	if err := json.Unmarshal([]byte(configJSON), &params); err != nil {
		return fmt.Errorf("parse recreate config: %w", err)
	}

	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect container: %w", err)
	}
	insp := inspResult.Container
	rollbackSnapshot, err := cloneInspectResponse(&insp)
	if err != nil {
		return fmt.Errorf("clone container for rollback: %w", err)
	}

	// Apply port binding overrides
	if params.Ports != nil {
		exposedPorts, portBindings, mappingErr := dockerPortMappings(params.Ports)
		if mappingErr != nil {
			return mappingErr
		}
		insp.HostConfig.PortBindings = portBindings
		insp.Config.ExposedPorts = exposedPorts
	}

	// Apply mount overrides
	if params.Mounts != nil {
		var binds []string
		for _, m := range params.Mounts {
			if m.HostPath != "" {
				bind := m.HostPath + ":" + m.ContainerPath
				if m.ReadOnly {
					bind += ":ro"
				}
				binds = append(binds, bind)
			} else if m.Name != "" {
				bind := m.Name + ":" + m.ContainerPath
				if m.ReadOnly {
					bind += ":ro"
				}
				binds = append(binds, bind)
			}
		}
		insp.HostConfig.Binds = binds
		// Clear Mounts field since we're using Binds
		insp.Mounts = nil
	}
	// Apply entrypoint override
	if params.Entrypoint != nil {
		insp.Config.Entrypoint = params.Entrypoint
	}

	// Apply command override
	if params.Command != nil {
		insp.Config.Cmd = params.Command
	}

	// Apply working directory override
	if params.WorkingDir != "" {
		insp.Config.WorkingDir = params.WorkingDir
	}

	// Apply user override
	if params.User != "" {
		insp.Config.User = params.User
	}

	// Apply hostname override
	if params.Hostname != "" {
		insp.Config.Hostname = params.Hostname
	}

	// Apply labels override
	if params.Labels != nil {
		preserveGatewayManagedContainerLabels(insp.Config.Labels, params.Labels)
		insp.Config.Labels = params.Labels
	}
	if params.StopTimeout != nil {
		insp.Config.StopTimeout = params.StopTimeout
	}

	// Apply runtime overrides to HostConfig so they persist after recreation.
	if params.RestartPolicy != nil {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(*params.RestartPolicy)}
		if *params.RestartPolicy == "on-failure" && params.MaxRetries != nil {
			policy.MaximumRetryCount = *params.MaxRetries
		}
		insp.HostConfig.RestartPolicy = policy
	} else if params.MaxRetries != nil && insp.HostConfig.RestartPolicy.Name == "on-failure" {
		insp.HostConfig.RestartPolicy.MaximumRetryCount = *params.MaxRetries
	}
	if params.MemoryLimit != nil {
		insp.HostConfig.Memory = *params.MemoryLimit
	}
	if params.MemorySwap != nil {
		insp.HostConfig.MemorySwap = *params.MemorySwap
	}
	if params.NanoCPUs != nil {
		applyNanoCPULimit(&insp.HostConfig.Resources, *params.NanoCPUs)
	}
	if params.CpuShares != nil {
		insp.HostConfig.CPUShares = *params.CpuShares
	}
	if params.PidsLimit != nil {
		pids := *params.PidsLimit
		insp.HostConfig.PidsLimit = &pids
	}
	if params.GPU != nil {
		if err := c.applyGPUConfig(ctx, insp.Config, insp.HostConfig, params.GPU); err != nil {
			return err
		}
	}
	if params.RuntimeProfile != nil {
		if err := c.applyRuntimeProfile(insp.HostConfig, *params.RuntimeProfile, params.GPU); err != nil {
			return err
		}
	}

	imageRef := params.Image
	if imageRef == "" {
		imageRef = insp.Config.Image
	} else if insp.Config.Labels != nil {
		if _, imported := insp.Config.Labels[archiveImageReferenceLabel]; imported {
			insp.Config.Labels[archiveImageReferenceLabel] = imageRef
		}
	}
	if imageRef == "" {
		imageRef = insp.Image
	}

	requestedExpectedRunning, err := parseRecreateExpectedRunning(params.ExpectedState)
	if err != nil {
		return err
	}

	return c.recreateContainer(ctx, &insp, imageRef, params.Env, params.RemoveEnv, rollbackSnapshot, requestedExpectedRunning)
}

func applyNanoCPULimit(resources *container.Resources, nanoCPUs int64) {
	resources.NanoCPUs = nanoCPUs
	resources.CPUPeriod = 0
	resources.CPUQuota = 0
}

// recreateContainer stops, removes, and recreates a container with the given
// imageRef, preserving all network connections. envOverrides are merged on top
// of the existing env; envRemovals are stripped.
func (c *Client) recreateContainer(
	ctx context.Context,
	insp *container.InspectResponse,
	imageRef string,
	envOverrides map[string]string,
	envRemovals []string,
	rollbackSnapshot *container.InspectResponse,
	requestedExpectedRunning *bool,
) error {
	name := strings.TrimPrefix(insp.Name, "/")
	if name == "" {
		name = insp.ID[:12]
	}

	wasRunning := insp.State != nil && insp.State.Running
	expectedRunning, err := c.resolveRecreateExpectedRunning(name, wasRunning, requestedExpectedRunning)
	if err != nil {
		return fmt.Errorf("resolve expected recreate state: %w", err)
	}
	if err := c.persistRecreateExpectedRunning(name, expectedRunning); err != nil {
		return fmt.Errorf("persist expected recreate state: %w", err)
	}

	if wasRunning {
		timeoutSec := defaultContainerStopTimeoutSeconds
		if insp.Config != nil && insp.Config.StopTimeout != nil && *insp.Config.StopTimeout >= 0 {
			timeoutSec = *insp.Config.StopTimeout
		}
		if _, err := c.cli.ContainerStop(ctx, insp.ID, client.ContainerStopOptions{Timeout: &timeoutSec}); err != nil {
			return fmt.Errorf("stop container: %w", err)
		}
	}

	// Remove the container
	if _, err := c.cli.ContainerRemove(ctx, insp.ID, client.ContainerRemoveOptions{Force: true}); err != nil {
		return fmt.Errorf("remove container: %w", err)
	}

	if _, err := c.createContainerFromInspect(ctx, insp, imageRef, envOverrides, envRemovals, expectedRunning); err != nil {
		if rollbackSnapshot != nil {
			rollbackImage := rollbackSnapshot.Config.Image
			if rollbackImage == "" {
				rollbackImage = rollbackSnapshot.Image
			}
			if rollbackImage == "" {
				rollbackImage = imageRef
			}
			if _, rollbackErr := c.createContainerFromInspect(ctx, rollbackSnapshot, rollbackImage, nil, nil, expectedRunning); rollbackErr != nil {
				return fmt.Errorf("create container: %w (rollback failed: %v)", err, rollbackErr)
			}
			if clearErr := c.clearRecreateExpectedRunning(name); clearErr != nil {
				return fmt.Errorf("create container: %w (original container restored; clear expected state: %v)", err, clearErr)
			}
			return fmt.Errorf("create container: %w (original container restored)", err)
		}
		return fmt.Errorf("create container: %w", err)
	}
	if err := c.clearRecreateExpectedRunning(name); err != nil {
		return fmt.Errorf("clear expected recreate state: %w", err)
	}

	return nil
}

func (c *Client) createContainerFromInspect(
	ctx context.Context,
	insp *container.InspectResponse,
	imageRef string,
	envOverrides map[string]string,
	envRemovals []string,
	expectedRunning bool,
) (string, error) {
	name := strings.TrimPrefix(insp.Name, "/")
	if name == "" {
		name = insp.ID[:12]
	}

	// Build new config
	createConfig := *insp.Config
	createConfig.Image = imageRef
	createConfig.Env = applyEnvChanges(insp.Config.Env, envOverrides, envRemovals)
	// Preserve all networks the container was connected to.
	// Docker only allows one network at creation time; the rest are connected after.
	netNames := inspectNetworkNames(insp)
	netNames, err := c.existingNetworkNames(ctx, netNames)
	if err != nil {
		return "", err
	}
	netNames = prioritizeNetworkNames(netNames, currentInspectNetworkMode(insp))
	hostConfig := *insp.HostConfig
	managedDatabaseHosts, err := c.managedDatabaseHostEntries(ctx, netNames)
	if err != nil {
		return "", err
	}
	hostConfig.ExtraHosts = mergeManagedDatabaseExtraHosts(hostConfig.ExtraHosts, managedDatabaseHosts)
	if len(netNames) > 0 {
		hostConfig.NetworkMode = container.NetworkMode(netNames[0])
	}

	createResult, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           &createConfig,
		HostConfig:       &hostConfig,
		NetworkingConfig: networkingConfigForInspectNetwork(insp, netNames),
		Name:             name,
	})
	if err != nil {
		return "", err
	}

	if err := c.connectContainerToAdditionalNetworks(ctx, createResult.ID, insp, netNames); err != nil {
		_, _ = c.cli.ContainerRemove(ctx, createResult.ID, client.ContainerRemoveOptions{Force: true})
		return "", fmt.Errorf("connect container networks: %w", err)
	}

	// Preserve the original running state. A stopped container should stay stopped.
	if expectedRunning {
		if _, err := c.cli.ContainerStart(ctx, createResult.ID, client.ContainerStartOptions{}); err != nil {
			_, _ = c.cli.ContainerRemove(ctx, createResult.ID, client.ContainerRemoveOptions{Force: true})
			return "", fmt.Errorf("start container: %w", err)
		}
	}

	return createResult.ID, nil
}

func parseRecreateExpectedRunning(state string) (*bool, error) {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "":
		return nil, nil
	case "running":
		value := true
		return &value, nil
	case "created":
		value := false
		return &value, nil
	default:
		return nil, fmt.Errorf("invalid expected recreate state %q", state)
	}
}

func (c *Client) recreateExpectedStatePath(name string) string {
	digest := sha256.Sum256([]byte(name))
	return filepath.Join(c.recreateStateDirectory, fmt.Sprintf("%x.state", digest))
}

func (c *Client) persistRecreateExpectedRunning(name string, expectedRunning bool) error {
	if c.recreateStateDirectory == "" {
		return nil
	}
	if err := os.MkdirAll(c.recreateStateDirectory, 0o700); err != nil {
		return err
	}
	value := []byte("created\n")
	if expectedRunning {
		value = []byte("running\n")
	}
	path := c.recreateExpectedStatePath(name)
	temporaryPath := path + ".tmp"
	if err := os.WriteFile(temporaryPath, value, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	return nil
}

func (c *Client) readRecreateExpectedRunning(name string) (bool, error) {
	if c.recreateStateDirectory == "" {
		return false, os.ErrNotExist
	}
	value, err := os.ReadFile(c.recreateExpectedStatePath(name))
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(string(value)) {
	case "running":
		return true, nil
	case "created":
		return false, nil
	default:
		return false, fmt.Errorf("invalid persisted recreate state")
	}
}

func (c *Client) clearRecreateExpectedRunning(name string) error {
	if c.recreateStateDirectory == "" {
		return nil
	}
	err := os.Remove(c.recreateExpectedStatePath(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (c *Client) resolveRecreateExpectedRunning(name string, currentRunning bool, requested *bool) (bool, error) {
	persisted, err := c.readRecreateExpectedRunning(name)
	if err == nil {
		if persisted != currentRunning {
			return persisted, nil
		}
		if clearErr := c.clearRecreateExpectedRunning(name); clearErr != nil {
			return false, clearErr
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if requested != nil {
		return *requested, nil
	}
	return currentRunning, nil
}
