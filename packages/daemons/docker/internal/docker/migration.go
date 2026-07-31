package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"golang.org/x/sys/unix"
)

type migrationFilesystemCapacity struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
}

type dockerMigrationCapabilities struct {
	Protocol          string                      `json:"protocol"`
	EngineVersion     string                      `json:"engineVersion"`
	APIVersion        string                      `json:"apiVersion"`
	OSType            string                      `json:"osType"`
	Architecture      string                      `json:"architecture"`
	StorageDriver     string                      `json:"storageDriver"`
	DockerRootDir     migrationFilesystemCapacity `json:"dockerRootDir"`
	StateDir          migrationFilesystemCapacity `json:"stateDir"`
	Runtimes          []string                    `json:"runtimes"`
	VolumePlugins     []string                    `json:"volumePlugins"`
	NetworkPlugins    []string                    `json:"networkPlugins"`
	SecurityOptions   []string                    `json:"securityOptions"`
	MaxChunkBytes     int                         `json:"maxChunkBytes"`
	ArtifactMaxAgeSec int64                       `json:"artifactMaxAgeSeconds"`
}

func (p *DockerPlugin) handleMigrationCommand(cmd *pb.DockerMigrationCommand, result *pb.CommandResult) {
	if p.migrationStore == nil {
		result.Success = false
		result.Error = "migration artifact store is unavailable"
		return
	}
	ctx := context.Background()
	var detail any
	var err error
	switch cmd.Action {
	case "capabilities":
		detail, err = p.migrationCapabilities(ctx)
	case "heartbeat":
		err = p.migrationStore.heartbeat(cmd.MigrationId)
	case "capture_manifest":
		detail, err = p.client.CaptureMigrationManifest(ctx, cmd.ResourceId)
	case "open_archive_export":
		detail, err = p.openArchiveExport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId, cmd.ConfigJson)
	case "open_archive_import":
		err = p.openArchiveImport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "finish_archive_import":
		detail, err = p.finishArchiveImport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "cleanup_archive_import":
		err = p.cleanupGwcaImportResources(ctx, cmd.MigrationId)
	case "prepare_image":
		detail, err = p.prepareMigrationImage(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId)
	case "prepare_volume":
		detail, err = p.prepareMigrationVolume(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId)
	case "measure_volume":
		detail, err = p.measureMigrationVolume(ctx, cmd.ResourceId)
	case "import_image":
		detail, err = p.importMigrationImage(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "import_volume":
		detail, err = p.importMigrationVolume(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "query_artifact":
		detail, err = p.migrationStore.query(cmd.MigrationId, cmd.ArtifactId)
	case "create_container_stopped":
		var request createStoppedContainerRequest
		if err = json.Unmarshal([]byte(cmd.ConfigJson), &request); err == nil {
			var id string
			id, err = p.client.CreateContainerStopped(ctx, request)
			detail = map[string]string{"containerId": id}
		}
	case "create_deployment_stopped":
		var request deploymentCommandPayload
		if err = json.Unmarshal([]byte(cmd.ConfigJson), &request); err == nil {
			detail, err = p.client.CreateDeploymentStopped(ctx, request)
		}
	case "finalize", "abort":
		if p.archiveStreams != nil {
			p.archiveStreams.removeArchive(cmd.MigrationId)
		}
		err = p.migrationStore.remove(cmd.MigrationId)
	default:
		err = fmt.Errorf("unknown Docker migration action %q", cmd.Action)
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	if detail != nil {
		data, marshalErr := json.Marshal(detail)
		if marshalErr != nil {
			result.Success = false
			result.Error = marshalErr.Error()
			return
		}
		result.Detail = string(data)
	}
}

func (p *DockerPlugin) migrationCapabilities(ctx context.Context) (dockerMigrationCapabilities, error) {
	version, err := p.client.cli.ServerVersion(ctx, struct{}{})
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("get Docker version: %w", err)
	}
	infoResult, err := p.client.cli.Info(ctx, struct{}{})
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("get Docker capabilities: %w", err)
	}
	info := infoResult.Info
	dockerCapacity, err := filesystemCapacity(info.DockerRootDir)
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("inspect Docker RootDir capacity: %w", err)
	}
	stateCapacity, err := filesystemCapacity(p.cfg.StateDir)
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("inspect migration state capacity: %w", err)
	}
	runtimes := make([]string, 0, len(info.Runtimes))
	for runtime := range info.Runtimes {
		runtimes = append(runtimes, runtime)
	}
	sort.Strings(runtimes)
	return dockerMigrationCapabilities{
		Protocol: "docker_migration_v1", EngineVersion: version.Version, APIVersion: version.APIVersion,
		OSType: info.OSType, Architecture: info.Architecture, StorageDriver: info.Driver,
		DockerRootDir: dockerCapacity, StateDir: stateCapacity, Runtimes: runtimes,
		VolumePlugins: append([]string(nil), info.Plugins.Volume...), NetworkPlugins: append([]string(nil), info.Plugins.Network...),
		SecurityOptions: append([]string(nil), info.SecurityOptions...), MaxChunkBytes: migrationChunkBytes,
		ArtifactMaxAgeSec: int64(migrationArtifactMaxAge.Seconds()),
	}, nil
}

func filesystemCapacity(path string) (migrationFilesystemCapacity, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return migrationFilesystemCapacity{}, err
	}
	return migrationFilesystemCapacity{Path: path, TotalBytes: stat.Blocks * uint64(stat.Bsize), FreeBytes: stat.Bavail * uint64(stat.Bsize)}, nil
}
