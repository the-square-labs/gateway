package docker

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

func storagePluginForTest() *DockerPlugin {
	return &DockerPlugin{cfg: &config.Config{Docker: config.DockerConfig{Mode: "storage"}}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

type fakeBackupCommandHandler struct{}

func (fakeBackupCommandHandler) handleBackupCommand(_ *pb.DockerBackupCommand, _ *pb.CommandResult) {}

func TestStorageProfileAdvertisesOnlyTypedStorageCapabilities(t *testing.T) {
	joined := strings.Join(storagePluginForTest().BuildRegisterMessage("node-1").Capabilities, ",")
	for _, required := range []string{"managed_databases_v1", "managed_storage_v1", "managed_storage_ext4_quota_v1", "managed_storage_iam_v1", "managed_storage_seaweedfs_v1"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing storage capability %s: %s", required, joined)
		}
	}
	if strings.Contains(joined, "database_backups_v1") {
		t.Fatalf("storage profile must not advertise backups without a registered handler: %s", joined)
	}
	plugin := storagePluginForTest()
	plugin.RegisterBackupCommandHandler(fakeBackupCommandHandler{})
	if !strings.Contains(strings.Join(plugin.BuildRegisterMessage("node-1").Capabilities, ","), "database_backups_v1") {
		t.Fatal("storage profile must advertise backups after a handler is registered")
	}
	for _, forbidden := range []string{"docker_deployments_v1", "docker_builder_profile_v1"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("storage profile advertised forbidden capability %s: %s", forbidden, joined)
		}
	}
}

func TestLegacyDatabaseProfileIsUnifiedStorageWithoutChangingPaths(t *testing.T) {
	plugin := storagePluginForTest()
	plugin.cfg.Docker.Mode = "databases"
	plugin.cfg.Docker.Database.StorageRoot = "/existing/database-volume"
	plugin.RegisterBackupCommandHandler(fakeBackupCommandHandler{})
	joined := strings.Join(plugin.BuildRegisterMessage("existing-node").Capabilities, ",")
	for _, capability := range []string{"managed_databases_v1", "managed_storage_v1", "database_backups_v1"} {
		if !strings.Contains(joined, capability) {
			t.Fatalf("legacy profile lacks %s", capability)
		}
	}
	for _, command := range []*pb.GatewayCommand{
		{Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "list"}}},
		{Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: &pb.DockerComposeCommand{}}},
	} {
		if plugin.HandleCommand(command).Success {
			t.Fatal("legacy stateful node accepted generic Docker command")
		}
	}
	storage := plugin.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerStorage{DockerStorage: &pb.DockerStorageCommand{Action: "inspect"}}})
	if storage.Error != "managed storage runtime is not initialized" {
		t.Fatalf("storage command not routed: %#v", storage)
	}
	if plugin.cfg.Docker.Database.StorageRoot != "/existing/database-volume" || plugin.cfg.Docker.Mode != "databases" {
		t.Fatal("legacy config was rewritten")
	}
}

func TestUnifiedStorageManagersPreserveExistingDatabaseRoot(t *testing.T) {
	for _, mode := range []string{"storage", "databases"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			cfg := &config.Config{Docker: config.DockerConfig{Mode: mode, Database: config.DatabaseConfig{StorageRoot: root}}}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			if _, err := newManagedDatabaseManager(cfg, nil, logger); err != nil {
				t.Fatal(err)
			}
			legacyFile := filepath.Join(root, "records", "existing.json")
			if err := os.WriteFile(legacyFile, []byte("existing-database-record"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := newManagedStorageManager(cfg, nil, logger); err != nil {
				t.Fatal(err)
			}
			for _, directory := range []string{"images", "mounts", "records", "tls", "storage/images", "storage/mounts", "storage/records"} {
				if info, err := os.Stat(filepath.Join(root, directory)); err != nil || !info.IsDir() {
					t.Fatalf("missing manager directory %s: %v", directory, err)
				}
			}
			data, err := os.ReadFile(legacyFile)
			if err != nil || string(data) != "existing-database-record" {
				t.Fatalf("database record changed: %s %v", data, err)
			}
		})
	}
}

func TestStorageProfileRejectsGenericDockerAndUnregisteredBackup(t *testing.T) {
	plugin := storagePluginForTest()
	for _, command := range []*pb.GatewayCommand{
		{CommandId: "container", Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "list"}}},
	} {
		result := plugin.HandleCommand(command)
		if result.Success || !strings.Contains(result.Error, "storage-profile daemon accepts only") {
			t.Fatalf("storage profile accepted %s: %#v", command.CommandId, result)
		}
	}
	database := plugin.HandleCommand(&pb.GatewayCommand{CommandId: "database", Payload: &pb.GatewayCommand_DockerDatabase{DockerDatabase: &pb.DockerDatabaseCommand{Action: "inspect"}}})
	if database.Success || database.Error != "managed database storage is not initialized" {
		t.Fatalf("storage profile must route typed database commands, got %#v", database)
	}
	result := plugin.HandleCommand(&pb.GatewayCommand{CommandId: "backup", Payload: &pb.GatewayCommand_DockerBackup{DockerBackup: &pb.DockerBackupCommand{Action: "status", RunId: "11111111-1111-4111-8111-111111111111"}}})
	if result.Success || result.Error != "backup command handler is not registered" {
		t.Fatalf("unregistered backup handler result: %#v", result)
	}
}

func TestStorageConnectorInternalWorkloadIsBounded(t *testing.T) {
	socketHostPath := storageConnectorRelayDirectory("/state")
	env := []string{
		"GATEWAY_CONNECTOR_BINDING_ID=11111111-1111-4111-8111-111111111111",
		"GATEWAY_CONNECTOR_SOCKET=" + storageConnectorSocketPath,
		"GATEWAY_CONNECTOR_LISTEN=:9000",
	}
	if !validStorageConnectorInternalWorkload(env, []string{socketHostPath + ":/run/gateway:ro"}, socketHostPath) {
		t.Fatal("expected bounded managed-storage connector workload")
	}
	env[2] = "GATEWAY_CONNECTOR_LISTEN=:9010"
	if validStorageConnectorInternalWorkload(env, []string{socketHostPath + ":/run/gateway:ro"}, socketHostPath) {
		t.Fatal("connector workload accepted a caller-selected listener")
	}
}

func TestManagedStorageConnectorWorkloadRequiresFixedOwnedShape(t *testing.T) {
	bindingID := "11111111-1111-4111-8111-111111111111"
	socketDirectory := storageConnectorRelayDirectory("/state")
	config := ContainerCreateConfig{
		InternalWorkload: managedStorageConnectorWorkload,
		Name:             "gateway-storage-connector-" + bindingID,
		Image:            developmentSecureLinkImage,
		User:             "65532:65532", NetworkMode: "private-network", NetworkAliases: []string{storageBindingAlias(bindingID)},
		Env: []string{
			"GATEWAY_CONNECTOR_BINDING_ID=" + bindingID,
			"GATEWAY_CONNECTOR_SOCKET=" + storageConnectorSocketPath,
			"GATEWAY_CONNECTOR_LISTEN=:9000",
		},
		Binds:  []string{socketDirectory + ":/run/gateway:ro"},
		Labels: map[string]string{managedStorageConnectorLabel: managedStorageConnectorWorkload},
	}
	if err := validateManagedStorageConnectorConfig(config, socketDirectory); err != nil {
		t.Fatalf("valid storage connector workload: %v", err)
	}
	config.Ports = []containerPortMapping{{ContainerPort: 9000}}
	if err := validateManagedStorageConnectorConfig(config, socketDirectory); err == nil {
		t.Fatal("storage connector workload accepted host publication")
	}
}

func TestStorageBindingNetworkIsInternalAndNameBounded(t *testing.T) {
	for _, name := range []string{"gateway-storage-1111111111111111", "gateway-storage-11111111-1111-4111-8111-111111111111"} {
		if !storageBindingNetworkNamePattern.MatchString(name) {
			t.Fatalf("expected storage binding network name %q to be valid", name)
		}
	}
	for _, name := range []string{"gateway-storage-storage-alias", "gateway-storage-11111111111111111", "gateway-storage-111111111111111G"} {
		if storageBindingNetworkNamePattern.MatchString(name) {
			t.Fatalf("expected storage binding network name %q to be invalid", name)
		}
	}
}
