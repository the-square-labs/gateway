//go:build linux

package docker

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// TestManagedStorageLifecycleE2E exercises the actual Linux allocator path.
// It is intentionally opt-in because it creates a loop-backed ext4 image and
// pulls the digest-pinned MinIO runtime through a disposable Docker daemon.
func TestManagedStorageLifecycleE2E(t *testing.T) {
	if os.Getenv("GATEWAY_MANAGED_STORAGE_E2E") != "1" {
		t.Skip("set GATEWAY_MANAGED_STORAGE_E2E=1 on a privileged Linux runner")
	}
	root := os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_ROOT")
	socket := os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_SOCKET")
	if root == "" || socket == "" {
		t.Fatal("GATEWAY_MANAGED_STORAGE_E2E_ROOT and GATEWAY_MANAGED_STORAGE_E2E_SOCKET are required")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := NewClient(socket, filepath.Join(root, "state"), logger)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := client.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	manager, err := newManagedStorageManager(&config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: root}}}, client, logger)
	if err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-4111-8111-111111111111"
	input := validManagedStorageCommand()
	input.OperationID = "22222222-2222-4222-8222-222222222222"
	record, err := manager.create(ctx, id, input)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = manager.remove(context.Background(), &record, true) }()
	if status := manager.storageStatus(ctx, record); status != "ready" {
		t.Fatalf("create status = %q, want ready", status)
	}
	inspect, err := client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if inspect.Container.HostConfig.Resources.NanoCPUs != input.Resources.NanoCPUs || inspect.Container.HostConfig.Resources.Memory != input.Resources.MemoryBytes {
		t.Fatalf("container limits = %#v", inspect.Container.HostConfig.Resources)
	}
	if len(inspect.Container.HostConfig.PortBindings) != 0 {
		t.Fatalf("private storage unexpectedly published host ports: %#v", inspect.Container.HostConfig.PortBindings)
	}
	endpoint, err := manager.privateEndpoint(ctx, record)
	if err != nil {
		t.Fatal(err)
	}
	minioClient, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(input.RootCredentials.AccessKey, input.RootCredentials.SecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	if err := minioClient.MakeBucket(ctx, "persist", minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := minioClient.PutObject(ctx, "persist", "value.txt", bytes.NewReader([]byte("preserved")), 9, minio.PutObjectOptions{}); err != nil {
		t.Fatal(err)
	}
	previousContainerID := record.ContainerID
	if err := client.RemoveContainer(ctx, record.ContainerID, true); err != nil {
		t.Fatal(err)
	}
	repaired, err := manager.create(ctx, id, input)
	if err != nil {
		t.Fatalf("repair idempotent create: %v", err)
	}
	if repaired.ContainerID == previousContainerID || repaired.ContainerID == "" {
		t.Fatalf("repair did not replace removed container: old=%q new=%q", previousContainerID, repaired.ContainerID)
	}
	record = repaired
	endpoint, err = manager.privateEndpoint(ctx, record)
	if err != nil {
		t.Fatal(err)
	}
	minioClient, err = minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(input.RootCredentials.AccessKey, input.RootCredentials.SecretKey, "")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := minioClient.StatObject(ctx, "persist", "value.txt", minio.StatObjectOptions{}); err != nil {
		t.Fatalf("object did not survive idempotent container repair: %v", err)
	}
	resize := managedStorageCommand{Version: 1, Resources: managedStorageResources{StorageBytes: 2 * minimumStorageBytes}}
	if err := manager.update(ctx, &record, resize); err != nil {
		t.Fatal(err)
	}
	if record.StorageBytes != 2*minimumStorageBytes {
		t.Fatalf("storage size = %d", record.StorageBytes)
	}
	if _, err := minioClient.StatObject(ctx, "persist", "value.txt", minio.StatObjectOptions{}); err != nil {
		t.Fatalf("object did not survive resize: %v", err)
	}
	if _, err := manager.handle(ctx, "stop", id, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.handle(ctx, "start", id, ""); err != nil {
		t.Fatal(err)
	}
	if err := manager.waitForReady(ctx, record); err != nil {
		t.Fatalf("restart readiness: %v", err)
	}
	if status := manager.storageStatus(ctx, record); status != "ready" {
		t.Fatalf("restart status = %q, want ready", status)
	}
	if _, err := minioClient.StatObject(ctx, "persist", "value.txt", minio.StatObjectOptions{}); err != nil {
		t.Fatalf("object did not survive restart: %v", err)
	}
	if _, err := manager.handle(ctx, "delete_data", id, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(record.ImagePath); !os.IsNotExist(err) {
		t.Fatalf("loop image remained after delete_data: %v", err)
	}
	if mounted(record.MountPath) {
		t.Fatal("managed storage mount remained after delete_data")
	}
}

func TestStorageBindingNetworkIntegrationE2E(t *testing.T) {
	if os.Getenv("GATEWAY_MANAGED_STORAGE_E2E") != "1" {
		t.Skip("set GATEWAY_MANAGED_STORAGE_E2E=1 on a privileged Linux runner")
	}
	root, socket := os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_ROOT"), os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_SOCKET")
	if root == "" || socket == "" {
		t.Fatal("GATEWAY_MANAGED_STORAGE_E2E_ROOT and GATEWAY_MANAGED_STORAGE_E2E_SOCKET are required")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := NewClient(socket, filepath.Join(root, "state"), logger)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	plugin := &DockerPlugin{client: client}
	name := "gateway-storage-3333333333333333"
	networkID, err := plugin.createStorageBindingNetwork(context.Background(), name, "bridge", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.RemoveNetwork(context.Background(), networkID) }()
	inspect, err := client.cli.NetworkInspect(context.Background(), networkID, mobyclient.NetworkInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !inspect.Network.Internal || inspect.Network.Driver != "bridge" || inspect.Network.Labels["wiolett.gateway.managed"] != managedStorageConnectorWorkload {
		t.Fatalf("binding network = %#v", inspect.Network)
	}
	bindingID := "33333333-3333-4333-8333-333333333333"
	if got, want := storageBindingAlias(bindingID), "storage-3333333333334333"; got != want {
		t.Fatalf("binding alias = %q, want %q", got, want)
	}
}
