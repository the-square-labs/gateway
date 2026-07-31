package docker

import (
	"context"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/distribution/reference"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func (p *DockerPlugin) availableArchiveContainerName(ctx context.Context, requested string) (string, error) {
	base := strings.TrimSpace(requested)
	if base == "" {
		base = "imported-container"
	}
	if _, err := p.client.cli.ContainerInspect(ctx, base, mobyclient.ContainerInspectOptions{}); isNotFoundErr(err) {
		return base, nil
	} else if err != nil {
		return "", fmt.Errorf("inspect target container name: %w", err)
	}
	for index := 2; index <= 9999; index++ {
		candidate := fmt.Sprintf("%s-%d", base, index)
		if len(candidate) > 255 {
			candidate = fmt.Sprintf("%s-%d", base[:max(1, 255-len(strconv.Itoa(index))-1)], index)
		}
		if _, err := p.client.cli.ContainerInspect(ctx, candidate, mobyclient.ContainerInspectOptions{}); isNotFoundErr(err) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("inspect target container name: %w", err)
		}
	}
	return "", fmt.Errorf("could not allocate an available container name")
}

func (p *DockerPlugin) prepareGwcaNetworks(
	ctx context.Context,
	archiveID string,
	manifest *gwcaContainerManifest,
) ([]string, error) {
	created := make([]string, 0)
	for index := range manifest.Networks {
		entry := &manifest.Networks[index]
		if entry.Name == "" {
			continue
		}
		if entry.CreateNew {
			name, err := p.availableArchiveNetworkName(ctx, entry.Name)
			if err != nil {
				return created, err
			}
			entry.Name = name
		} else {
			if _, err := p.client.cli.NetworkInspect(ctx, entry.Name, mobyclient.NetworkInspectOptions{}); err == nil {
				continue
			} else if !isNotFoundErr(err) {
				return created, fmt.Errorf("inspect target network %q: %w", entry.Name, err)
			}
		}
		if entry.Createable {
			options := mobyclient.NetworkCreateOptions{
				Driver: entry.Driver,
				Labels: map[string]string{"wiolett.gateway.archive.id": archiveID},
			}
			if entry.Subnet != "" || entry.Gateway != "" {
				ipamConfig := network.IPAMConfig{}
				if entry.Subnet != "" {
					prefix, parseErr := netip.ParsePrefix(entry.Subnet)
					if parseErr != nil {
						return created, fmt.Errorf("parse archive network subnet %q: %w", entry.Subnet, parseErr)
					}
					ipamConfig.Subnet = prefix
				}
				if entry.Gateway != "" && entry.Gateway != "invalid IP" {
					gateway, parseErr := netip.ParseAddr(entry.Gateway)
					if parseErr != nil {
						return created, fmt.Errorf("parse archive network gateway %q: %w", entry.Gateway, parseErr)
					}
					ipamConfig.Gateway = gateway
				}
				options.IPAM = &network.IPAM{Config: []network.IPAMConfig{ipamConfig}}
			}
			if _, createErr := p.client.cli.NetworkCreate(ctx, entry.Name, options); createErr == nil {
				created = append(created, entry.Name)
				continue
			} else if entry.CreateNew {
				return created, fmt.Errorf("create archive network %q: %w", entry.Name, createErr)
			}
		}
		entry.Name = "bridge"
	}
	seen := make(map[string]bool)
	filtered := manifest.Networks[:0]
	for _, entry := range manifest.Networks {
		if entry.Name == "" || seen[entry.Name] {
			continue
		}
		seen[entry.Name] = true
		filtered = append(filtered, entry)
	}
	manifest.Networks = filtered
	return created, nil
}

func (p *DockerPlugin) availableArchiveNetworkName(ctx context.Context, requested string) (string, error) {
	if _, err := p.client.cli.NetworkInspect(ctx, requested, mobyclient.NetworkInspectOptions{}); isNotFoundErr(err) {
		return requested, nil
	} else if err != nil {
		return "", fmt.Errorf("inspect target network name: %w", err)
	}
	for index := 2; index <= 9999; index++ {
		candidate := fmt.Sprintf("%s-gwca-%d", requested, index)
		if _, err := p.client.cli.NetworkInspect(ctx, candidate, mobyclient.NetworkInspectOptions{}); isNotFoundErr(err) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("inspect target network name: %w", err)
		}
	}
	return "", fmt.Errorf("could not allocate an available network name")
}

func (p *DockerPlugin) prepareGwcaMounts(
	ctx context.Context,
	archiveID string,
	containerName string,
	manifest *gwcaContainerManifest,
) ([]string, error) {
	created := make([]string, 0)
	shortID := strings.ReplaceAll(archiveID, "-", "")
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	for index := range manifest.Mounts {
		entry := &manifest.Mounts[index]
		if entry.Type != "volume" {
			continue
		}
		if !entry.CreateNew {
			if inspected, err := p.client.cli.VolumeInspect(ctx, entry.Source, mobyclient.VolumeInspectOptions{}); err != nil {
				return created, fmt.Errorf("target volume %q is unavailable; remap this volume before import: %w", entry.Source, err)
			} else if entry.Driver != "" && inspected.Volume.Driver != entry.Driver {
				return created, fmt.Errorf("target volume %q uses driver %q instead of %q", entry.Source, inspected.Volume.Driver, entry.Driver)
			}
			continue
		}
		base := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
				return r
			}
			return '-'
		}, containerName)
		name := fmt.Sprintf("%s-gwca-%s-%d", base, shortID, index+1)
		driver := entry.Driver
		if driver == "" {
			driver = "local"
		}
		createdVolume, err := p.client.cli.VolumeCreate(ctx, mobyclient.VolumeCreateOptions{
			Name: name, Driver: driver, Labels: mergeArchiveLabels(entry.Labels, archiveID),
		})
		if err != nil {
			return created, fmt.Errorf("create empty archive volume: %w", err)
		}
		entry.Source = createdVolume.Volume.Name
		entry.CreateNew = false
		created = append(created, createdVolume.Volume.Name)
	}
	return created, nil
}

func mergeArchiveLabels(labels map[string]string, archiveID string) map[string]string {
	result := sanitizeGwcaLabels(labels)
	if result == nil {
		result = map[string]string{}
	}
	result["wiolett.gateway.archive.id"] = archiveID
	return result
}

func (p *DockerPlugin) cleanupGwcaImportResources(ctx context.Context, archiveID string) error {
	if strings.TrimSpace(archiveID) == "" {
		return fmt.Errorf("archive ID is required")
	}
	label := "wiolett.gateway.archive.id=" + archiveID
	volumes, err := p.client.cli.VolumeList(ctx, mobyclient.VolumeListOptions{
		Filters: mobyclient.Filters{}.Add("label", label),
	})
	if err != nil {
		return fmt.Errorf("list archive import volumes: %w", err)
	}
	for _, volume := range volumes.Items {
		if _, removeErr := p.client.cli.VolumeRemove(ctx, volume.Name, mobyclient.VolumeRemoveOptions{Force: true}); removeErr != nil && !isNotFoundErr(removeErr) {
			return fmt.Errorf("remove archive import volume %q: %w", volume.Name, removeErr)
		}
	}
	networks, err := p.client.cli.NetworkList(ctx, mobyclient.NetworkListOptions{
		Filters: mobyclient.Filters{}.Add("label", label),
	})
	if err != nil {
		return fmt.Errorf("list archive import networks: %w", err)
	}
	for _, target := range networks.Items {
		if _, removeErr := p.client.cli.NetworkRemove(ctx, target.ID, mobyclient.NetworkRemoveOptions{}); removeErr != nil && !isNotFoundErr(removeErr) {
			return fmt.Errorf("remove archive import network %q: %w", target.Name, removeErr)
		}
	}
	return nil
}

func (p *DockerPlugin) prepareArchiveCreateImageReference(ctx context.Context, imageID, sourceReference string) (string, string) {
	sourceReference = strings.TrimSpace(sourceReference)
	if sourceReference == "" || dockerSHA256Digest.MatchString(sourceReference) {
		return imageID, ""
	}
	named, err := reference.ParseNormalizedNamed(sourceReference)
	if err != nil {
		p.logger.Warn("ignore invalid archive image reference", "image_reference", sourceReference, "error", err)
		return imageID, ""
	}
	if _, digested := named.(reference.Digested); digested {
		canonical := named.String()
		inspected, inspectErr := p.client.cli.ImageInspect(ctx, canonical)
		if inspectErr == nil && inspected.ID == imageID {
			return canonical, canonical
		}
		return imageID, canonical
	}
	tagged := reference.TagNameOnly(named).String()
	existing, inspectErr := p.client.cli.ImageInspect(ctx, tagged)
	if inspectErr == nil {
		if existing.ID == imageID {
			return tagged, tagged
		}
		p.logger.Warn("preserve conflicting archive image tag as metadata", "image_id", imageID, "image_reference", tagged)
		return imageID, tagged
	}
	if !isNotFoundErr(inspectErr) {
		p.logger.Warn("inspect archive image tag", "image_reference", tagged, "error", inspectErr)
		return imageID, tagged
	}
	if _, err := p.client.cli.ImageTag(ctx, mobyclient.ImageTagOptions{Source: imageID, Target: tagged}); err != nil {
		p.logger.Warn("preserve archive image tag", "image_id", imageID, "image_reference", tagged, "error", err)
		return imageID, tagged
	}
	inspected, err := p.client.cli.ImageInspect(ctx, tagged)
	if err != nil || inspected.ID != imageID {
		p.logger.Warn("verify preserved archive image tag", "image_id", imageID, "image_reference", tagged, "error", err)
		return imageID, tagged
	}
	return tagged, tagged
}
