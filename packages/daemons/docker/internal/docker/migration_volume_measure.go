package docker

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/moby/moby/api/types/volume"
	mobyclient "github.com/moby/moby/client"
)

type migrationVolumeMeasure struct {
	VolumeName   string `json:"volumeName"`
	EntryCount   int64  `json:"entryCount"`
	LogicalBytes int64  `json:"logicalBytes"`
}

func (p *DockerPlugin) measureMigrationVolume(ctx context.Context, volumeName string) (migrationVolumeMeasure, error) {
	volume, err := p.client.cli.VolumeInspect(ctx, volumeName, mobyclient.VolumeInspectOptions{})
	if err != nil {
		return migrationVolumeMeasure{}, fmt.Errorf("inspect migration volume: %w", err)
	}
	if err := migratableLocalVolume(volume.Volume); err != nil {
		return migrationVolumeMeasure{}, err
	}
	entries, logicalBytes, err := measureMigrationTree(volume.Volume.Mountpoint)
	if err != nil {
		return migrationVolumeMeasure{}, err
	}
	return migrationVolumeMeasure{VolumeName: volumeName, EntryCount: entries, LogicalBytes: logicalBytes}, nil
}

// migratableLocalVolume refuses a volume the migration cannot copy from its
// directory. Local driver options mount a host path, a network share or tmpfs
// while a container uses the volume: once the source stops, the directory
// holds none of that data and the volume would migrate empty.
func migratableLocalVolume(v volume.Volume) error {
	if v.Driver != "local" || v.Mountpoint == "" {
		return fmt.Errorf("only mounted local volumes are supported")
	}
	if len(v.Options) > 0 {
		return fmt.Errorf("volume %q mounts storage through local driver options and is host-bound", v.Name)
	}
	return nil
}

func measureMigrationTree(root string) (int64, int64, error) {
	var entries, logicalBytes int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || path == root {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if _, err := migrationEntryKind(info.Mode()); err != nil {
			return fmt.Errorf("measure %s: %w", entry.Name(), err)
		}
		if unsupported, err := hasUnsupportedMigrationXattrs(path); err != nil {
			return fmt.Errorf("inspect volume metadata for %s: %w", entry.Name(), err)
		} else if unsupported {
			return fmt.Errorf("extended attributes or ACLs are not supported: %s", entry.Name())
		}
		entries++
		if info.Mode().IsRegular() {
			logicalBytes += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, 0, fmt.Errorf("measure migration volume: %w", err)
	}
	return entries, logicalBytes, nil
}
