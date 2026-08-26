package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

type dockerMigrationManifest struct {
	SchemaVersion    int                       `json:"schemaVersion"`
	SourceID         string                    `json:"sourceId"`
	Name             string                    `json:"name"`
	ImageID          string                    `json:"imageId"`
	ImageReference   string                    `json:"imageReference"`
	Platform         string                    `json:"platform,omitempty"`
	Config           *container.Config         `json:"config"`
	HostConfig       *container.HostConfig     `json:"hostConfig"`
	NetworkingConfig *network.NetworkingConfig `json:"networkingConfig"`
	EnvKeys          []string                  `json:"envKeys"`
	VolumeNames      []string                  `json:"volumeNames"`
	Blockers         []string                  `json:"blockers"`
	Warnings         []string                  `json:"warnings"`
}

type createStoppedContainerRequest struct {
	MigrationID string                  `json:"migrationId"`
	Manifest    dockerMigrationManifest `json:"manifest"`
	Env         []string                `json:"env"`
}

const migrationOwnershipLabel = "wiolett.gateway.migration.id"
const archiveImageReferenceLabel = "wiolett.gateway.archive.image.reference"

func configuredArchiveImageReference(image string, labels map[string]string) string {
	if archivedReference := strings.TrimSpace(labels[archiveImageReferenceLabel]); archivedReference != "" {
		return archivedReference
	}
	return strings.TrimSpace(image)
}

func (c *Client) CaptureMigrationManifest(ctx context.Context, id string) (dockerMigrationManifest, error) {
	inspected, err := c.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{Size: true})
	if err != nil {
		return dockerMigrationManifest{}, fmt.Errorf("inspect migration source container: %w", err)
	}
	ctr := inspected.Container
	if ctr.Config == nil || ctr.HostConfig == nil {
		return dockerMigrationManifest{}, fmt.Errorf("source inspect is missing create configuration")
	}
	config := cloneContainerConfig(ctr.Config)
	delete(config.Labels, migrationOwnershipLabel)
	imageReference := configuredArchiveImageReference(ctr.Config.Image, config.Labels)
	delete(config.Labels, archiveImageReferenceLabel)
	hostConfig := cloneHostConfig(ctr.HostConfig)
	manifest := dockerMigrationManifest{
		SchemaVersion:  1,
		SourceID:       ctr.ID,
		Name:           strings.TrimPrefix(ctr.Name, "/"),
		ImageID:        ctr.Image,
		ImageReference: imageReference,
		Platform:       ctr.Platform,
		Config:         config,
		HostConfig:     hostConfig,
	}

	envSeen := map[string]bool{}
	for _, value := range config.Env {
		key, _, _ := strings.Cut(value, "=")
		if key != "" {
			if envSeen[key] {
				manifest.Blockers = append(manifest.Blockers, fmt.Sprintf("duplicate environment key %q", key))
			}
			envSeen[key] = true
			manifest.EnvKeys = append(manifest.EnvKeys, key)
		}
	}
	sort.Strings(manifest.EnvKeys)
	config.Env = nil
	if len(hostConfig.LogConfig.Config) > 0 {
		manifest.Blockers = append(manifest.Blockers, "Docker log driver options may contain secrets and require explicit migration support")
		for key := range hostConfig.LogConfig.Config {
			hostConfig.LogConfig.Config[key] = ""
		}
	}

	if hasComposeLabels(config.Labels) {
		manifest.Blockers = append(manifest.Blockers, "host-managed Docker Compose resources are not migratable")
	}
	if len(hostConfig.VolumesFrom) > 0 {
		manifest.Blockers = append(manifest.Blockers, "volumes-from dependencies are host-bound")
	}
	if len(hostConfig.Links) > 0 {
		manifest.Blockers = append(manifest.Blockers, "legacy container links are host-bound")
	}
	if hostConfig.ContainerIDFile != "" {
		manifest.Blockers = append(manifest.Blockers, "container ID files are host-bound")
	}
	if hostConfig.Runtime == "runsc" {
		manifest.Blockers = append(manifest.Blockers, "Secure Runtime containers are not migratable between nodes")
	}
	if hostNamespaceMode(string(hostConfig.NetworkMode)) || hostNamespaceMode(string(hostConfig.IpcMode)) ||
		hostNamespaceMode(string(hostConfig.PidMode)) || hostNamespaceMode(string(hostConfig.UTSMode)) {
		manifest.Blockers = append(manifest.Blockers, "host or container namespace sharing is not portable")
	}
	manifest.VolumeNames, manifest.Blockers = classifyMigrationMounts(ctr.Mounts, manifest.Blockers)

	if ctr.NetworkSettings != nil {
		endpoints := make(map[string]*network.EndpointSettings, len(ctr.NetworkSettings.Networks))
		for name, source := range ctr.NetworkSettings.Networks {
			if source == nil {
				continue
			}
			endpoints[name] = &network.EndpointSettings{
				IPAMConfig: source.IPAMConfig,
				Links:      append([]string(nil), source.Links...),
				Aliases:    portableNetworkAliases(source.Aliases, ctr.ID),
				DriverOpts: cloneStringMap(source.DriverOpts),
				GwPriority: source.GwPriority,
			}
			if source.IPAddress.IsValid() || source.GlobalIPv6Address.IsValid() {
				manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("dynamic address on network %q will be reassigned", name))
			}
			if source.MacAddress != nil {
				manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("runtime MAC address on network %q will be reassigned", name))
			}
		}
		manifest.NetworkingConfig = &network.NetworkingConfig{EndpointsConfig: endpoints}
	}

	if err := rejectUnknownCreateFields(inspected.Raw, reflect.TypeOf(container.Config{}), reflect.TypeOf(container.HostConfig{})); err != nil {
		manifest.Blockers = append(manifest.Blockers, err.Error())
	}
	if ctr.SizeRw != nil && *ctr.SizeRw > 0 {
		manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("writable layer contains %d bytes and is not migrated", *ctr.SizeRw))
	}
	sort.Strings(manifest.Blockers)
	manifest.Blockers = compactStrings(manifest.Blockers)
	return manifest, nil
}

func classifyMigrationMounts(
	mounts []container.MountPoint,
	blockers []string,
) ([]string, []string) {
	var volumeNames []string
	for _, mount := range mounts {
		switch string(mount.Type) {
		case "volume":
			if mount.Name == "" {
				blockers = append(blockers, "anonymous volumes are not migratable")
				continue
			}
			if mount.Driver != "local" {
				blockers = append(blockers, fmt.Sprintf("volume %q uses unsupported driver %q", mount.Name, mount.Driver))
			}
			volumeNames = append(volumeNames, mount.Name)
		case "bind":
			blockers = append(blockers, "bind mounts are host-bound")
		default:
			blockers = append(blockers, fmt.Sprintf("mount type %q is not supported", mount.Type))
		}
	}
	sort.Strings(volumeNames)
	return compactStrings(volumeNames), blockers
}

func portableNetworkAliases(aliases []string, containerID string) []string {
	shortID := containerID
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}
	result := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		if alias != containerID && alias != shortID {
			result = append(result, alias)
		}
	}
	return result
}

func (c *Client) CreateContainerStopped(ctx context.Context, req createStoppedContainerRequest) (string, error) {
	manifest := req.Manifest
	if req.MigrationID == "" || manifest.SchemaVersion != 1 || manifest.Config == nil || manifest.HostConfig == nil {
		return "", fmt.Errorf("unsupported or incomplete migration manifest")
	}
	if existing, err := c.cli.ContainerInspect(ctx, manifest.Name, mobyclient.ContainerInspectOptions{}); err == nil {
		if existing.Container.Config != nil && existing.Container.Config.Labels[migrationOwnershipLabel] == req.MigrationID {
			return existing.Container.ID, nil
		}
		return "", fmt.Errorf("target container name %q is already in use", manifest.Name)
	}
	if len(manifest.Blockers) > 0 {
		return "", fmt.Errorf("migration manifest contains blockers")
	}
	if len(req.Env) != len(manifest.EnvKeys) {
		return "", fmt.Errorf("environment value count does not match manifest")
	}
	actualKeys := make([]string, 0, len(req.Env))
	for _, value := range req.Env {
		key, _, ok := strings.Cut(value, "=")
		if !ok || key == "" {
			return "", fmt.Errorf("invalid environment entry")
		}
		actualKeys = append(actualKeys, key)
	}
	sort.Strings(actualKeys)
	if strings.Join(actualKeys, "\x00") != strings.Join(manifest.EnvKeys, "\x00") {
		return "", fmt.Errorf("environment keys do not match manifest")
	}
	config := cloneContainerConfig(manifest.Config)
	config.Env = append([]string(nil), req.Env...)
	if err := applyMigrationCreateImage(config, manifest); err != nil {
		return "", err
	}
	if config.Labels == nil {
		config.Labels = map[string]string{}
	}
	config.Labels[migrationOwnershipLabel] = req.MigrationID
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: config, HostConfig: cloneHostConfig(manifest.HostConfig), NetworkingConfig: manifest.NetworkingConfig, Name: manifest.Name,
	})
	if err != nil {
		return "", fmt.Errorf("create stopped migration container: %w", err)
	}
	return resp.ID, nil
}

func applyMigrationCreateImage(config *container.Config, manifest dockerMigrationManifest) error {
	if config == nil || !dockerSHA256Digest.MatchString(manifest.ImageID) {
		return fmt.Errorf("migration manifest has no verified image digest")
	}
	config.Image = manifest.ImageID
	if original := strings.TrimSpace(manifest.ImageReference); original != "" && original != manifest.ImageID {
		if config.Labels == nil {
			config.Labels = map[string]string{}
		}
		config.Labels[archiveImageReferenceLabel] = original
	}
	return nil
}

func cloneContainerConfig(source *container.Config) *container.Config {
	data, _ := json.Marshal(source)
	var target container.Config
	_ = json.Unmarshal(data, &target)
	return &target
}

func cloneHostConfig(source *container.HostConfig) *container.HostConfig {
	data, _ := json.Marshal(source)
	var target container.HostConfig
	_ = json.Unmarshal(data, &target)
	return &target
}

func hasComposeLabels(labels map[string]string) bool {
	for key := range labels {
		if strings.HasPrefix(key, "com.docker.compose.") {
			return true
		}
	}
	return false
}

func hostNamespaceMode(value string) bool {
	return value == "host" || strings.HasPrefix(value, "container:")
}

func compactStrings(values []string) []string {
	if len(values) < 2 {
		return values
	}
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}

func cloneStringMap(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	target := make(map[string]string, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func rejectUnknownCreateFields(raw []byte, configType, hostConfigType reflect.Type) error {
	var inspect map[string]json.RawMessage
	if err := json.Unmarshal(raw, &inspect); err != nil {
		return fmt.Errorf("decode raw container inspect: %w", err)
	}
	checks := []struct {
		name string
		typ  reflect.Type
	}{{"Config", configType}, {"HostConfig", hostConfigType}}
	for _, check := range checks {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(inspect[check.name], &object); err != nil {
			return fmt.Errorf("decode raw %s: %w", check.name, err)
		}
		known := jsonFieldNames(check.typ)
		for key := range object {
			if !known[key] {
				return fmt.Errorf("unknown Docker create field %s.%s", check.name, key)
			}
		}
	}
	return nil
}

func jsonFieldNames(typ reflect.Type) map[string]bool {
	result := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.Anonymous {
			for name := range jsonFieldNames(field.Type) {
				result[name] = true
			}
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		result[name] = true
	}
	return result
}
