package docker

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func validManagedStorageCommand() managedStorageCommand {
	return managedStorageCommand{
		Version:        1,
		OperationID:    "11111111-1111-4111-8111-111111111111",
		Image:          trustedMinioImage,
		ImageCatalogID: "minio-release-2025-04-22",
		RootCredentials: managedStorageRootCreds{
			AccessKey: "storage-root",
			SecretKey: "storage-root-secret",
		},
		Resources: managedStorageResources{
			NanoCPUs:        minimumStorageNanoCPUs,
			MemoryBytes:     256 * 1024 * 1024,
			MemorySwapBytes: 256 * 1024 * 1024,
			StorageBytes:    minimumStorageBytes,
		},
	}
}

func encodeManagedStorageCommand(t *testing.T, input managedStorageCommand) string {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestManagedStorageCommandAcceptsFractionalCPUAndPinnedImage(t *testing.T) {
	input, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, validManagedStorageCommand()), true)
	if err != nil {
		t.Fatalf("parse valid managed storage command: %v", err)
	}
	if input.Resources.NanoCPUs != 100_000_000 {
		t.Fatalf("nanoCPUs = %d, want 100000000", input.Resources.NanoCPUs)
	}
}

func TestManagedStorageCommandRejectsMutableOrUnexpectedImage(t *testing.T) {
	input := validManagedStorageCommand()
	input.Image = "minio/minio:RELEASE.2025-04-22T22-12-26Z"
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err == nil {
		t.Fatal("expected mutable MinIO tag to be rejected")
	}
	input = validManagedStorageCommand()
	input.ImageCatalogID = "minio"
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err == nil {
		t.Fatal("expected mismatched MinIO catalog id to be rejected")
	}
}

func TestManagedStoragePublicationDistinguishesPrivateAndPeerTopology(t *testing.T) {
	private := validManagedStorageCommand()
	private.PublishedPort = 9000
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, private), true); err == nil {
		t.Fatal("expected single-node private storage host publication to be rejected")
	}

	peer := validManagedStorageCommand()
	peer.PublishedPort = 9000
	peer.PeerBindAddress = "192.0.2.10"
	peer.Members = []managedStorageMember{
		{MemberIndex: 0, Endpoint: "https://192.0.2.10:9000/data"},
		{MemberIndex: 1, Endpoint: "https://192.0.2.11:9000/data"},
	}
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, peer), true); err != nil {
		t.Fatalf("expected peer-bound distributed storage to be accepted: %v", err)
	}
	peer.PublishS3 = true
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, peer), true); err != nil {
		t.Fatalf("expected public distributed storage with a peer bind address to be accepted: %v", err)
	}
	peer.PeerBindAddress = "0.0.0.0"
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, peer), true); err == nil {
		t.Fatal("expected wildcard peer binding to be rejected")
	}
}

func TestStageManagedStorageTLSWritesOwnedPrivateFiles(t *testing.T) {
	root := t.TempDir()
	manager := &managedStorageManager{root: root}
	record := managedStorageRecord{ID: "11111111-1111-4111-8111-111111111111", MemberIndex: 2}
	directory, err := manager.stageTLS(record, managedStorageTLS{CertPEM: "certificate", KeyPEM: "private-key", CAPEM: "certificate-authority", ServerName: "storage.example"})
	if err != nil {
		t.Fatalf("stage TLS: %v", err)
	}
	for _, expected := range []struct{ path, content string }{
		{filepath.Join(directory, "public.crt"), "certificate"},
		{filepath.Join(directory, "private.key"), "private-key"},
		{filepath.Join(directory, "CAs", "gateway-ca.crt"), "certificate-authority"},
	} {
		data, err := os.ReadFile(expected.path)
		if err != nil || string(data) != expected.content {
			t.Fatalf("staged TLS file %s = %q, err=%v", expected.path, data, err)
		}
		info, err := os.Stat(expected.path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("staged TLS file mode %s = %v, err=%v", expected.path, info.Mode(), err)
		}
	}
}

func TestManagedStorageRendersTypedFTPAndSFTPArguments(t *testing.T) {
	input := validManagedStorageCommand()
	input.FTP = &managedStorageFTP{Port: 8021, PassivePortStart: 30000, PassivePortCount: 10}
	input.SFTP = &managedStorageSFTP{Port: 8022, HostKeyPEM: "ssh-host-key"}
	command := strings.Join(minioCommand(input), " ")
	for _, expected := range []string{"--ftp=address=:8021", "--ftp=passive-port-range=30000-30009", "--sftp=address=:8022", "--sftp=ssh-private-key=/run/gateway-minio-sftp/host-key"} {
		if !strings.Contains(command, expected) {
			t.Fatalf("MinIO command %q missing %q", command, expected)
		}
	}
}

func TestStageManagedStorageSFTPHostKeyIsOwnedAndPrivate(t *testing.T) {
	manager := &managedStorageManager{root: t.TempDir()}
	path, err := manager.stageSFTPHostKey(managedStorageRecord{ID: "11111111-1111-4111-8111-111111111111", MemberIndex: 3}, "ssh-host-key")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "ssh-host-key" {
		t.Fatalf("host key = %q, err=%v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("host key mode = %v, err=%v", info.Mode(), err)
	}
}

func TestManagedStorageSFTPRequiresHostKey(t *testing.T) {
	input := validManagedStorageCommand()
	input.SFTP = &managedStorageSFTP{Port: 8022}
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err == nil {
		t.Fatal("expected SFTP without a host key to be rejected")
	}
}

func TestManagedStorageUpdateValidatesTypedTransport(t *testing.T) {
	input := validManagedStorageCommand()
	input.Version = 1
	input.SFTP = &managedStorageSFTP{Port: 8022}
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), false); err == nil {
		t.Fatal("expected update with invalid SFTP transport to be rejected")
	}
}

func TestManagedStorageDistributedHealthUsesClusterEndpoint(t *testing.T) {
	if got := managedStorageHealthPath(managedStorageRecord{MemberCount: 2}); got != "/minio/health/cluster" {
		t.Fatalf("distributed health path = %q", got)
	}
	if got := managedStorageHealthPath(managedStorageRecord{MemberCount: 1}); got != "/minio/health/ready" {
		t.Fatalf("single member health path = %q", got)
	}
}

func TestManagedStorageIAMAcceptsClientTrustWithoutServerPrivateKey(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	input := validManagedStorageCommand()
	input.TLS = &managedStorageTLS{CAPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})), ServerName: "storage.example"}
	raw := encodeManagedStorageCommand(t, input)
	if _, err := parseManagedStorageIAMCommand(raw); err != nil {
		t.Fatalf("IAM client trust rejected: %v", err)
	}
	for _, creating := range []bool{true, false} {
		if _, err := parseManagedStorageCommand(raw, creating); err == nil {
			t.Fatal("server transport accepted missing certificate/private key")
		}
	}
	input.TLS.ServerName = ""
	if _, err := parseManagedStorageIAMCommand(encodeManagedStorageCommand(t, input)); err == nil {
		t.Fatal("IAM accepted missing server identity")
	}
}

func TestManagedStoragePublishesFileProtocolsWithoutPublicS3(t *testing.T) {
	var created struct {
		container.Config
		HostConfig container.HostConfig
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/json"):
			_, _ = w.Write([]byte(`{"Id":"image"}`))
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"Id":"test"}`))
		case strings.HasSuffix(r.URL.Path, "/start"):
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected Docker request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost(server.URL), mobyclient.WithVersion("1.43"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	manager := &managedStorageManager{root: t.TempDir(), client: &Client{cli: cli, logger: slog.Default()}}
	input := validManagedStorageCommand()
	// Decode transport fixtures through the production command schema.
	raw := encodeManagedStorageCommand(t, input)
	raw = strings.TrimSuffix(raw, "}") + `,"ftp":{"port":2121,"passivePortStart":30000,"passivePortCount":2}}`
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		t.Fatal(err)
	}
	input.SFTP = &managedStorageSFTP{Port: 8022, HostKeyPEM: "test-key"}
	_, err = manager.createContainer(context.Background(), &managedStorageRecord{ID: "test", MountPath: t.TempDir(), ContainerName: "test", NetworkName: "test", PublishS3: false}, input)
	if err != nil {
		t.Fatal(err)
	}
	s3, _ := network.ParsePort("9000/tcp")
	if _, ok := created.HostConfig.PortBindings[s3]; ok {
		t.Fatal("private S3 unexpectedly published")
	}
	for _, value := range []string{"2121/tcp", "30000/tcp", "30001/tcp", "8022/tcp"} {
		port, _ := network.ParsePort(value)
		if len(created.HostConfig.PortBindings[port]) != 1 {
			t.Fatalf("missing FTP binding %s", value)
		}
	}
}
