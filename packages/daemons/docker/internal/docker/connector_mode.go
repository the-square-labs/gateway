package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

// A node switches between a root and a non-root docker-daemon by re-running
// its installer. The connector socket directories and the connector containers
// of the previous mode do not fit the new one (owned by uid 65532, or shared
// through the previous user's group); the daemon brings both over by itself.

// claimConnectorDirectory gives a daemon without root its socket directory with
// mode. A directory a root daemon left behind belongs to uid 65532 and cannot be
// changed; its sockets are stale, so it is set aside and created anew.
func claimConnectorDirectory(path string, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil {
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != daemonEUID() {
			aside := fmt.Sprintf("%s.previous-owner-%d", path, time.Now().UnixNano())
			if err := os.Rename(path, aside); err != nil {
				return fmt.Errorf("set aside %s owned by uid %d: %w", path, stat.Uid, err)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

// reconcileStorageConnectorGroups recreates the managed storage connectors whose
// supplementary groups do not match this daemon's mode: one created by a root
// daemon cannot reach the socket of a daemon without root, and one created by a
// non-root daemon keeps that user's group. Each is recreated with the same
// name, image, environment, network and alias; Proxy Secure Link connectors are
// replaced the same way when their links are restored (validSecureLinkConnector).
func (p *DockerPlugin) reconcileStorageConnectorGroups(ctx context.Context) {
	if p.client == nil {
		return
	}
	listed, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedStorageConnectorLabel+"="+managedStorageConnectorWorkload),
	})
	if err != nil {
		p.logger.Warn("could not check storage connectors for the daemon's user", "error", err)
		return
	}
	for _, candidate := range listed.Items {
		inspected, err := p.client.cli.ContainerInspect(ctx, candidate.ID, mobyclient.ContainerInspectOptions{})
		if err != nil || inspected.Container.HostConfig == nil || sameConnectorGroups(inspected.Container.HostConfig.GroupAdd) {
			continue
		}
		if err := p.recreateStorageConnector(ctx, inspected.Container); err != nil {
			p.logger.Error("could not recreate a storage connector for the daemon's user", "container", strings.TrimPrefix(inspected.Container.Name, "/"), "error", err)
			continue
		}
		p.logger.Info("recreated a storage connector for the daemon's user", "container", strings.TrimPrefix(inspected.Container.Name, "/"), "groups", connectorGroupAdd())
	}
}

// storageConnectorConfigOf rebuilds the create request of an existing managed
// storage connector, so the recreated one passes the same validation.
func storageConnectorConfigOf(inspect container.InspectResponse) (ContainerCreateConfig, error) {
	if inspect.Config == nil || inspect.HostConfig == nil || inspect.NetworkSettings == nil || len(inspect.NetworkSettings.Networks) != 1 {
		return ContainerCreateConfig{}, fmt.Errorf("storage connector %s has an unexpected shape", inspect.Name)
	}
	config := ContainerCreateConfig{
		InternalWorkload: managedStorageConnectorWorkload,
		Name:             strings.TrimPrefix(inspect.Name, "/"),
		Image:            inspect.Config.Image,
		Env:              inspect.Config.Env,
		User:             inspect.Config.User,
		Labels:           inspect.Config.Labels,
		Binds:            inspect.HostConfig.Binds,
	}
	bindingID := strings.TrimPrefix(config.Name, "gateway-storage-connector-")
	for name, endpoint := range inspect.NetworkSettings.Networks {
		config.NetworkMode = name
		if endpoint != nil {
			for _, alias := range endpoint.Aliases {
				if alias == storageBindingAlias(bindingID) {
					config.NetworkAliases = []string{alias}
				}
			}
		}
	}
	// The image may set variables of its own; only the connector's own pass validation.
	env := config.Env[:0:0]
	for _, value := range config.Env {
		if strings.HasPrefix(value, "GATEWAY_CONNECTOR_") {
			env = append(env, value)
		}
	}
	config.Env = env
	return config, nil
}

func (p *DockerPlugin) recreateStorageConnector(ctx context.Context, inspect container.InspectResponse) error {
	config, err := storageConnectorConfigOf(inspect)
	if err != nil {
		return err
	}
	// Refuse before removing anything: only a valid managed connector is recreated.
	if err := validateManagedStorageConnectorConfig(config, storageConnectorRelayDirectory(p.cfg.StateDir)); err != nil {
		return err
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	wasRunning := inspect.State != nil && inspect.State.Running
	if err := p.client.RemoveContainer(ctx, inspect.ID, true); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("remove storage connector: %w", err)
	}
	id, _, err := p.createManagedStorageConnector(ctx, string(raw))
	if err != nil {
		return err
	}
	if !wasRunning {
		if _, err := p.client.cli.ContainerStop(ctx, id, mobyclient.ContainerStopOptions{}); err != nil {
			return fmt.Errorf("keep the recreated storage connector stopped: %w", err)
		}
	}
	return nil
}
