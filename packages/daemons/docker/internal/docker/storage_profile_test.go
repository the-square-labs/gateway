package docker

import (
	"io"
	"log/slog"
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
	for _, required := range []string{"managed_databases_v1", "managed_storage_v1", "managed_storage_ext4_quota_v1", "managed_storage_iam_v1"} {
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
