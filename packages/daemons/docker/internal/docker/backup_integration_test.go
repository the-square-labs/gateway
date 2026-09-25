//go:build linux

package docker

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// TestBackupRunToolPostgresS3IntegrationE2E executes the immutable backup
// runner image against real PostgreSQL and a SeaweedFS S3 endpoint under the
// daemon's bounded loop-backed workspace. It is intentionally opt-in and
// Linux-only. The S3 fixture defaults to the digest-pinned SeaweedFS runtime
// (GHCR mirror first, Docker Hub fallback); MinIO's public images are gone.
func TestBackupRunToolPostgresS3IntegrationE2E(t *testing.T) {
	if os.Getenv("GATEWAY_BACKUP_E2E") != "1" {
		t.Skip("set GATEWAY_BACKUP_E2E=1 on a privileged Linux runner")
	}
	root, socket := os.Getenv("GATEWAY_BACKUP_E2E_ROOT"), os.Getenv("GATEWAY_BACKUP_E2E_SOCKET")
	postgresImage, s3Image, toolImage := os.Getenv("GATEWAY_BACKUP_E2E_POSTGRES_IMAGE"), os.Getenv("GATEWAY_BACKUP_E2E_S3_IMAGE"), os.Getenv("GATEWAY_BACKUP_E2E_TOOL_IMAGE")
	if s3Image == "" {
		s3Image = seaweedfsUpstreamImage
	}
	if root == "" || socket == "" || postgresImage == "" || toolImage == "" {
		t.Fatal("backup E2E root, socket, postgres and tool image environment are required")
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

	postgresID, postgresPort := startBackupE2EContainer(t, ctx, client, postgresImage,
		[]string{"POSTGRES_USER=backup", "POSTGRES_PASSWORD=backup-secret", "POSTGRES_DB=app"}, nil, nil, "5432/tcp")
	defer func() { _ = client.RemoveContainer(context.Background(), postgresID, true) }()
	waitBackupE2ETCP(t, ctx, "127.0.0.1", postgresPort)

	// One static admin identity; the secret travels in the environment so it is
	// never interpolated into the shell command.
	const s3AccessKey, s3SecretKey = "backup-e2e", "backup-e2e-secret"
	s3ID, s3Port := startBackupE2EContainer(t, ctx, client, s3Image,
		[]string{"S3_SECRET=" + s3SecretKey}, []string{"sh", "-c"},
		[]string{`printf '{"identities":[{"name":"backup-e2e","credentials":[{"accessKey":"` + s3AccessKey + `","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' "$S3_SECRET" > /tmp/s3.json && exec /usr/bin/weed server -dir=/data -ip=127.0.0.1 -ip.bind=127.0.0.1 -s3 -s3.port=9000 -s3.ip.bind=0.0.0.0 -s3.config=/tmp/s3.json -s3.port.iceberg=0 -s3.port.lance=0`},
		"9000/tcp")
	defer func() { _ = client.RemoveContainer(context.Background(), s3ID, true) }()
	s3Client, err := minio.New(net.JoinHostPort("127.0.0.1", s3Port), &minio.Options{Creds: credentials.NewStaticV4(s3AccessKey, s3SecretKey, ""), Region: "us-east-1"})
	if err != nil {
		t.Fatal(err)
	}
	// SeaweedFS opens its S3 listener before the filer behind it is ready, so
	// wait for a real bucket operation rather than a TCP connect.
	for {
		err := s3Client.MakeBucket(ctx, "backups", minio.MakeBucketOptions{})
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("S3 fixture never accepted a bucket: %v", err)
		case <-time.After(500 * time.Millisecond):
		}
	}

	manager, err := newManagedDatabaseManager(&config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: root}}}, client, logger)
	if err != nil {
		t.Fatal(err)
	}
	daemonConfig := &config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: root}}}
	daemonConfig.StateDir = filepath.Join(root, "daemon")
	runtime := &backupRuntime{plugin: &DockerPlugin{cfg: daemonConfig, client: client, databaseManager: manager}, root: filepath.Join(root, "backup-state"), runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}}
	if err := os.MkdirAll(runtime.root, 0700); err != nil {
		t.Fatal(err)
	}
	payload := backupPayload{
		RunID: "44444444-4444-4444-8444-444444444444", Version: 1, Direction: "backup", Engine: "postgres", ToolImage: toolImage,
		Source:      backupEndpoint{ConnectionID: "source", Host: "127.0.0.1", Port: mustBackupE2EPort(t, postgresPort), Database: "app", Username: "backup", Password: "backup-secret"},
		Destination: backupEndpoint{ConnectionID: "destination", Provider: "s3", Endpoint: "http://" + net.JoinHostPort("127.0.0.1", s3Port), Bucket: "backups", Prefix: "nightly", AccessKeyID: s3AccessKey, SecretAccessKey: s3SecretKey, ForcePathStyle: true},
		Limits:      backupLimits{WorkspaceBytes: backupMinWorkspace, TimeoutSeconds: 120, CPUCores: 1, MemoryMB: 256},
	}
	status, err := runtime.runTool(ctx, payload.RunID, payload, "immutable", "backup")
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "completed" || status.Bytes <= 0 || len(status.Manifest) == 0 {
		t.Fatalf("backup result = %#v", status)
	}
	if _, err := s3Client.StatObject(ctx, "backups", "nightly/"+payload.RunID+"/database.dump", minio.StatObjectOptions{}); err != nil {
		t.Fatalf("native runner did not upload PostgreSQL dump: %v", err)
	}
	if _, err := os.Stat(filepath.Join(manager.root, "backups", "images", payload.RunID+".img")); !os.IsNotExist(err) {
		t.Fatalf("bounded workspace image remained after runTool: %v", err)
	}
}

func startBackupE2EContainer(t *testing.T, ctx context.Context, client *Client, image string, env, entrypoint, command []string, port string) (string, string) {
	t.Helper()
	// Allow-listed third-party images resolve through the GHCR mirror first.
	image, err := client.EnsureThirdPartyImage(ctx, image)
	if err != nil {
		t.Fatal(err)
	}
	containerPort, err := network.ParsePort(port)
	if err != nil {
		t.Fatal(err)
	}
	created, err := client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     &container.Config{Image: image, Env: env, Entrypoint: entrypoint, Cmd: command, ExposedPorts: network.PortSet{containerPort: {}}},
		HostConfig: &container.HostConfig{PortBindings: network.PortMap{containerPort: {{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: "0"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	inspect, err := client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	bindings := inspect.Container.NetworkSettings.Ports[containerPort]
	if len(bindings) != 1 || bindings[0].HostPort == "" {
		t.Fatalf("port binding = %#v", bindings)
	}
	return created.ID, bindings[0].HostPort
}

func waitBackupE2ETCP(t *testing.T, ctx context.Context, host, port string) {
	t.Helper()
	for {
		connection, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, port))
		if err == nil {
			_ = connection.Close()
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("wait service %s:%s: %v", host, port, ctx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func mustBackupE2EPort(t *testing.T, value string) int {
	t.Helper()
	var port int
	if _, err := fmt.Sscanf(value, "%d", &port); err != nil || port < 1 || port > 65535 {
		t.Fatalf("invalid port %q", value)
	}
	return port
}
