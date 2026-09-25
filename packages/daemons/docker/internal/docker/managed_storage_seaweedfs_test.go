package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7/pkg/signer"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

func validSeaweedFSCommand() managedStorageCommand {
	return managedStorageCommand{
		Version:        2,
		Engine:         managedStorageEngineSeaweedFS,
		OperationID:    "11111111-1111-4111-8111-111111111111",
		ImageCatalogID: seaweedfsCatalogID,
		RootCredentials: managedStorageRootCreds{
			AccessKey: "gw0123456789abcdef01",
			SecretKey: "root-secret_0123456789-abcdefghijkl",
		},
		Resources: managedStorageResources{
			NanoCPUs:        minimumStorageNanoCPUs,
			MemoryBytes:     minimumSeaweedFSMemoryBytes,
			MemorySwapBytes: minimumSeaweedFSMemoryBytes,
			StorageBytes:    minimumStorageBytes,
		},
	}
}

func TestManagedStorageVersionBindsEngine(t *testing.T) {
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, validSeaweedFSCommand()), true); err != nil {
		t.Fatalf("valid SeaweedFS create rejected: %v", err)
	}
	legacy, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, validManagedStorageCommand()), true)
	if err != nil || legacy.Engine != managedStorageEngineMinIO {
		t.Fatalf("version 1 payload engine = %q, err = %v", legacy.Engine, err)
	}
	for name, mutate := range map[string]func(*managedStorageCommand){
		"version 2 without engine":   func(c *managedStorageCommand) { c.Engine = "" },
		"version 2 with minio":       func(c *managedStorageCommand) { c.Engine = managedStorageEngineMinIO },
		"version 1 with seaweedfs":   func(c *managedStorageCommand) { c.Version = 1 },
		"unknown version":            func(c *managedStorageCommand) { c.Version = 3 },
		"unknown engine on version2": func(c *managedStorageCommand) { c.Engine = "garage" },
	} {
		input := validSeaweedFSCommand()
		mutate(&input)
		if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestSeaweedFSCommandRejectsOutOfContractFields(t *testing.T) {
	for name, mutate := range map[string]func(*managedStorageCommand){
		"ftp": func(c *managedStorageCommand) {
			c.FTP = &managedStorageFTP{Port: 2121, PassivePortStart: 30000, PassivePortCount: 1}
		},
		"sftp": func(c *managedStorageCommand) { c.SFTP = &managedStorageSFTP{Port: 8022, HostKeyPEM: "key"} },
		"distributed": func(c *managedStorageCommand) {
			c.Members = []managedStorageMember{{0, "http://a:9000/data"}, {1, "http://b:9000/data"}}
		},
		"member index":    func(c *managedStorageCommand) { c.MemberIndex = 1 },
		"peer bind":       func(c *managedStorageCommand) { c.PeerBindAddress = "192.0.2.10" },
		"catalog":         func(c *managedStorageCommand) { c.ImageCatalogID = "minio-release-2025-04-22" },
		"untrusted image": func(c *managedStorageCommand) { c.Image = "docker.io/chrislusf/seaweedfs:latest" },
		"other digest":    func(c *managedStorageCommand) { c.Image = seaweedfsUpstreamRepo + "@sha256:" + strings.Repeat("0", 64) },
		"minio image":     func(c *managedStorageCommand) { c.Image = trustedMinioImage },
		"memory":          func(c *managedStorageCommand) { c.Resources.MemoryBytes = 256 * 1024 * 1024 },
		"root key":        func(c *managedStorageCommand) { c.RootCredentials.AccessKey = "root/key" },
		"root secret":     func(c *managedStorageCommand) { c.RootCredentials.SecretKey = "short" },
		"secret spaces":   func(c *managedStorageCommand) { c.RootCredentials.SecretKey = "has spaces in it" },
		"public no port":  func(c *managedStorageCommand) { c.PublishS3 = true },
		"private port":    func(c *managedStorageCommand) { c.PublishedPort = 9000 },
		"partial tls":     func(c *managedStorageCommand) { c.TLS = &managedStorageTLS{CAPEM: "ca", ServerName: "storage"} },
	} {
		input := validSeaweedFSCommand()
		mutate(&input)
		if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	for _, image := range []string{"", seaweedfsUpstreamImage, "ghcr.io/the-square-labs/gateway/seaweedfs@" + seaweedfsImageDigest} {
		input := validSeaweedFSCommand()
		input.Image = image
		input.PublishS3, input.PublishedPort = true, 19000
		if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, input), true); err != nil {
			t.Fatalf("trusted image %q rejected: %v", image, err)
		}
	}
	update := managedStorageCommand{Version: 2, Engine: managedStorageEngineSeaweedFS, Resources: managedStorageResources{StorageBytes: 2 * minimumStorageBytes}}
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, update), false); err != nil {
		t.Fatalf("SeaweedFS update without credentials rejected: %v", err)
	}
	update.Resources.MemoryBytes = 128 * 1024 * 1024
	if _, err := parseManagedStorageCommand(encodeManagedStorageCommand(t, update), false); err == nil {
		t.Fatal("SeaweedFS update below the memory minimum accepted")
	}
}

func TestSeaweedFSSizingScalesWithDisk(t *testing.T) {
	for _, tc := range []struct {
		bytes                  int64
		volume, maximum, floor int64
	}{
		{minimumStorageBytes, 32, 32 + seaweedfsBucketAllowance, 64},
		{10 * minimumStorageBytes, 160, 64 + seaweedfsBucketAllowance, 512},
		{64 * minimumStorageBytes, 1024, 64 + seaweedfsBucketAllowance, 2048},
		{maximumStorageBytes, 1024, 16384 + seaweedfsBucketAllowance, 2048},
	} {
		got := seaweedfsSizingFor(tc.bytes)
		if got.VolumeSizeLimitMB != tc.volume || got.VolumeMax != tc.maximum || got.MinFreeSpaceMiB != tc.floor {
			t.Fatalf("sizing(%d) = %#v", tc.bytes, got)
		}
		if got.VolumeSizeLimitMB*(got.VolumeMax-seaweedfsBucketAllowance) < tc.bytes/mebibyte {
			t.Fatalf("sizing(%d) cannot hold a full disk: %#v", tc.bytes, got)
		}
	}
}

func TestSeaweedFSCommandRendersContractFlags(t *testing.T) {
	record := managedStorageRecord{StorageBytes: minimumStorageBytes}
	joined := " " + strings.Join(seaweedfsCommand(record), " ") + " "
	for _, expected := range []string{
		" -config_dir=/run/gateway-storage/config server ", " -dir=/data ", " -ip=127.0.0.1 ", " -ip.bind=127.0.0.1 ",
		" -master.defaultReplication=000 ", " -master.volumePreallocate=false ", " -master.volumeSizeLimitMB=32 ",
		" -volume.max=288 ", " -volume.index=memory ", " -volume.minFreeSpace=64MiB ", " -volume.preStopSeconds=2 ", " -s3 ", " -s3.port=9000 ",
		" -s3.ip.bind=0.0.0.0 ", " -s3.config=/run/gateway-storage/config/s3.json ", " -s3.iam=true ",
		" -s3.iam.readOnly=false ", " -s3.allowDeleteBucketNotEmpty=false ", " -s3.port.iceberg=0 ", " -s3.port.lance=0 ",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("command %q misses %q", joined, expected)
		}
	}
	if strings.Contains(joined, "cert.file") || strings.Contains(joined, "-sftp") || strings.Contains(joined, "-webdav") {
		t.Fatalf("plain command renders optional listeners: %q", joined)
	}
	record.TLSEnabled = true
	joined = strings.Join(seaweedfsCommand(record), " ")
	if !strings.Contains(joined, "-s3.cert.file=/run/gateway-storage/tls/public.crt") || !strings.Contains(joined, "-s3.key.file=/run/gateway-storage/tls/private.key") {
		t.Fatalf("TLS command = %q", joined)
	}
	health := seaweedfsHealthcheck(true)
	if health.Test[0] != "CMD-SHELL" || !strings.Contains(health.Test[1], "127.0.0.1:9333/readyz") || !strings.Contains(health.Test[1], "127.0.0.1:8888/healthz") ||
		!strings.Contains(health.Test[1], "127.0.0.1:8080/healthz") || !strings.Contains(health.Test[1], "https://127.0.0.1:9000/healthz") {
		t.Fatalf("healthcheck = %#v", health.Test)
	}
}

type recordedChown struct {
	path     string
	uid, gid int
}

func TestSeaweedFSStagingIsOwnedReadOnlyAndReusable(t *testing.T) {
	var mu sync.Mutex
	var chowned []recordedChown
	manager := &managedStorageManager{root: t.TempDir(), chown: func(path string, uid, gid int) error {
		mu.Lock()
		defer mu.Unlock()
		chowned = append(chowned, recordedChown{filepath.Base(strings.TrimSuffix(path, ".pending")), uid, gid})
		return nil
	}}
	record := managedStorageRecord{ID: "11111111-1111-4111-8111-111111111111", Engine: managedStorageEngineSeaweedFS, TLSEnabled: true}
	input := validSeaweedFSCommand()
	input.TLS = &managedStorageTLS{CertPEM: "certificate", KeyPEM: "private-key", CAPEM: "authority", ServerName: "storage.example"}
	root, err := manager.stageSeaweedFS(record, input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.removeSeaweedFSStaging(record) })
	for path, mode := range map[string]os.FileMode{
		root: 0o500, filepath.Join(root, "config"): 0o500, filepath.Join(root, "tls"): 0o500,
		filepath.Join(root, "config", "s3.json"): 0o400, filepath.Join(root, "config", "security.toml"): 0o400,
		filepath.Join(root, "config", "master.toml"): 0o400, filepath.Join(root, "tls", "public.crt"): 0o400,
		filepath.Join(root, "tls", "private.key"): 0o400, filepath.Join(root, "tls", "ca.crt"): 0o400,
	} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("%s mode = %v, err = %v", path, info.Mode(), err)
		}
	}
	for _, entry := range chowned {
		if entry.uid != seaweedfsRuntimeUID || entry.gid != seaweedfsRuntimeGID {
			t.Fatalf("staged %s owned by %d:%d", entry.path, entry.uid, entry.gid)
		}
	}
	for _, name := range []string{"s3.json", "security.toml", "master.toml", "public.crt", "private.key", "ca.crt", "config", "tls"} {
		found := false
		for _, entry := range chowned {
			found = found || entry.path == name
		}
		if !found {
			t.Fatalf("%s was not handed to the runtime user: %v", name, chowned)
		}
	}
	accessKey, secretKey, err := manager.readSeaweedFSRootCredentials(record)
	if err != nil || accessKey != input.RootCredentials.AccessKey || secretKey != input.RootCredentials.SecretKey {
		t.Fatalf("root identity round trip = %q %q %v", accessKey, secretKey, err)
	}
	identities, _ := os.ReadFile(filepath.Join(root, "config", "s3.json"))
	var parsed seaweedfsIdentityConfig
	if err := json.Unmarshal(identities, &parsed); err != nil || len(parsed.Identities) != 1 || parsed.Identities[0].Name != seaweedfsRootIdentity || !reflect.DeepEqual(parsed.Identities[0].Actions, []string{"Admin", "Read", "Write", "List", "Tagging"}) {
		t.Fatalf("static identities = %s", identities)
	}
	security, _ := os.ReadFile(filepath.Join(root, "config", "security.toml"))
	if !regexp.MustCompile(`(?m)^\[jwt\.filer_signing\]\nkey = "[0-9a-f]{64}"$`).Match(security) {
		t.Fatalf("security.toml = %q", security)
	}
	master, _ := os.ReadFile(filepath.Join(root, "config", "master.toml"))
	if !strings.Contains(string(master), "copy_1 = 1") {
		t.Fatalf("master.toml = %q", master)
	}
	// Recreation without the secrets in the payload reuses the staged tree.
	reuse := managedStorageCommand{Version: 2, Engine: managedStorageEngineSeaweedFS}
	if _, err := manager.stageSeaweedFS(record, reuse); err != nil {
		t.Fatalf("restage from staged secrets: %v", err)
	}
	if accessKey, _, err := manager.readSeaweedFSRootCredentials(record); err != nil || accessKey != input.RootCredentials.AccessKey {
		t.Fatalf("restaged identity = %q %v", accessKey, err)
	}
	changed, err := manager.restageSeaweedFSTLS(record, managedStorageTLS{CertPEM: "rotated", KeyPEM: "rotated-key", CAPEM: "authority", ServerName: "storage.example"})
	if err != nil || !changed {
		t.Fatalf("TLS rotation changed=%v err=%v", changed, err)
	}
	if changed, err := manager.restageSeaweedFSTLS(record, managedStorageTLS{CertPEM: "rotated", KeyPEM: "rotated-key", CAPEM: "authority"}); err != nil || changed {
		t.Fatalf("unchanged TLS reported changed=%v err=%v", changed, err)
	}
	plain := record
	plain.TLSEnabled = false
	if _, err := manager.stageSeaweedFS(plain, reuse); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "tls")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("TLS material survived a plain restage: %v", err)
	}
	if err := manager.removeSeaweedFSStaging(record); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging survived removal: %v", err)
	}
}

type capturedContainerCreate struct {
	container.Config
	HostConfig       container.HostConfig
	NetworkingConfig network.NetworkingConfig
}

func newFakeStorageEngine(t *testing.T, created *capturedContainerCreate) *fakeImageEngine {
	engine := newFakeImageEngine()
	engine.other = func(w http.ResponseWriter, r *http.Request) bool {
		switch {
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			if err := json.NewDecoder(r.Body).Decode(created); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"Id":"created"}`))
			return true
		case strings.HasSuffix(r.URL.Path, "/start"):
			w.WriteHeader(http.StatusNoContent)
			return true
		}
		return false
	}
	return engine
}

func TestSeaweedFSContainerRunsUnprivilegedWithHealthcheck(t *testing.T) {
	for _, published := range []bool{false, true} {
		var created capturedContainerCreate
		manager := &managedStorageManager{root: t.TempDir(), chown: func(string, int, int) error { return nil }, client: newFakeImageClient(t, newFakeStorageEngine(t, &created))}
		record := managedStorageRecord{
			ID: "11111111-1111-4111-8111-111111111111", Engine: managedStorageEngineSeaweedFS, ContainerName: "gateway-storage-test-0",
			NetworkName: "gateway-storage-test", MountPath: "/srv/storage/mounts/test-0", Image: seaweedfsUpstreamImage,
			StorageBytes: minimumStorageBytes, MemoryBytes: minimumSeaweedFSMemoryBytes, NanoCPUs: minimumStorageNanoCPUs,
			PublishS3: published,
		}
		if published {
			record.PublishedPort = 19000
		}
		if _, err := manager.createSeaweedFSContainer(context.Background(), &record, validSeaweedFSCommand()); err != nil {
			t.Fatal(err)
		}
		if created.User != "1000:1000" || !reflect.DeepEqual(created.Entrypoint, []string{"/usr/bin/weed"}) || created.Image != seaweedfsUpstreamImage {
			t.Fatalf("container identity = user %q entrypoint %v image %q", created.User, created.Entrypoint, created.Image)
		}
		if created.Healthcheck == nil || created.Healthcheck.Test[0] != "CMD-SHELL" || created.Healthcheck.StartPeriod == 0 {
			t.Fatalf("healthcheck = %#v", created.Healthcheck)
		}
		if created.Labels[managedStorageEngineLabel] != managedStorageEngineSeaweedFS || created.Labels[managedStorageLabel] != record.ID {
			t.Fatalf("labels = %v", created.Labels)
		}
		if !reflect.DeepEqual(created.Env, []string{"GOMEMLIMIT=435MiB", "WEED_TLS_CERT_REFRESH_INTERVAL=1m"}) {
			t.Fatalf("env = %v (no secrets may be passed in the environment)", created.Env)
		}
		staging := manager.seaweedfsStagingDir(record)
		t.Cleanup(func() { _ = manager.removeSeaweedFSStaging(record) })
		if !reflect.DeepEqual(created.HostConfig.Binds, []string{"/srv/storage/mounts/test-0:/data", staging + ":/run/gateway-storage:ro"}) {
			t.Fatalf("binds = %v", created.HostConfig.Binds)
		}
		if !reflect.DeepEqual(created.HostConfig.CapDrop, []string{"ALL"}) || !reflect.DeepEqual(created.HostConfig.SecurityOpt, []string{"no-new-privileges:true"}) {
			t.Fatalf("hardening = %v %v", created.HostConfig.CapDrop, created.HostConfig.SecurityOpt)
		}
		s3, _ := network.ParsePort("9000/tcp")
		bindings := created.HostConfig.PortBindings[s3]
		if published != (len(bindings) == 1) || len(created.HostConfig.PortBindings) > 1 {
			t.Fatalf("published=%v port bindings = %v", published, created.HostConfig.PortBindings)
		}
		if published && (bindings[0].HostPort != "19000" || bindings[0].HostIP.String() != "0.0.0.0") {
			t.Fatalf("published binding = %#v", bindings[0])
		}
	}
}

func TestManagedStoragePublicationChangeDetection(t *testing.T) {
	private := managedStorageRecord{}
	if managedStoragePublicationChanged(private, managedStorageCommand{}) {
		t.Fatal("unchanged private publication reported as changed")
	}
	if !managedStoragePublicationChanged(private, managedStorageCommand{PublishS3: true, PublishedPort: 19000}) {
		t.Fatal("publishing a private cluster not detected")
	}
	public := managedStorageRecord{PublishS3: true, PublishedPort: 19000}
	if !managedStoragePublicationChanged(public, managedStorageCommand{PublishS3: true, PublishedPort: 19001}) {
		t.Fatal("port move not detected")
	}
	if !managedStoragePublicationChanged(public, managedStorageCommand{}) {
		t.Fatal("unpublishing not detected")
	}
	peer := managedStorageRecord{PublishedPort: 9000, PeerBindAddress: "192.0.2.10", MemberCount: 4}
	if managedStoragePublicationChanged(peer, managedStorageCommand{PublishedPort: 9000, PeerBindAddress: "192.0.2.10"}) {
		t.Fatal("unchanged distributed publication reported as changed")
	}
	if (managedStorageRecord{}).engine() != managedStorageEngineMinIO {
		t.Fatal("legacy record without engine is not MinIO")
	}
}

func TestManagedStorageImageErrorsAreTyped(t *testing.T) {
	engine := newFakeImageEngine()
	engine.failing[trustedMinioImage] = true
	mirror, _ := thirdPartyMirrorReference(seaweedfsUpstreamImage)
	engine.failing[mirror] = true
	engine.failing[seaweedfsUpstreamImage] = true
	manager := &managedStorageManager{root: t.TempDir(), client: newFakeImageClient(t, engine), logger: slog.Default()}
	if _, err := manager.ensureEngineImage(context.Background(), managedStorageEngineMinIO); err == nil || !strings.HasPrefix(err.Error(), managedStorageEngineImageUnavailableCode+": ") {
		t.Fatalf("legacy MinIO error = %v", err)
	}
	_, err := manager.ensureEngineImage(context.Background(), managedStorageEngineSeaweedFS)
	if err == nil || !strings.HasPrefix(err.Error(), managedStorageImagePullFailedCode+": ") || !strings.Contains(err.Error(), mirror) || !strings.Contains(err.Error(), seaweedfsUpstreamImage) {
		t.Fatalf("SeaweedFS pull error = %v", err)
	}
	if !reflect.DeepEqual(engine.pulls, []string{trustedMinioImage, mirror, seaweedfsUpstreamImage}) {
		t.Fatalf("pull order = %v", engine.pulls)
	}
	engine.present[trustedMinioImage] = true
	if image, err := manager.ensureEngineImage(context.Background(), managedStorageEngineMinIO); err != nil || image != trustedMinioImage {
		t.Fatalf("cached legacy MinIO image = %q %v", image, err)
	}
}

// A publication change that needs the unavailable legacy image must fail
// before the running container is stopped, renamed or removed.
func TestManagedStorageRecreateFailsBeforeTouchingLegacyContainer(t *testing.T) {
	engine := newFakeImageEngine()
	engine.failing[trustedMinioImage] = true
	var touched []string
	engine.other = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.Contains(r.URL.Path, "/containers/") {
			touched = append(touched, r.Method+" "+r.URL.Path)
			if strings.HasSuffix(r.URL.Path, "/update") {
				_, _ = w.Write([]byte(`{}`))
				return true
			}
		}
		return false
	}
	manager := &managedStorageManager{root: t.TempDir(), client: newFakeImageClient(t, engine), logger: slog.Default()}
	record := managedStorageRecord{ID: "11111111-1111-4111-8111-111111111111", ContainerID: "running", ContainerName: "gateway-storage-x-0", MemberCount: 1, StorageBytes: minimumStorageBytes, MemoryBytes: 256 * 1024 * 1024}
	update := validManagedStorageCommand()
	update.Resources.StorageBytes = 0
	update.PublishS3, update.PublishedPort = true, 19000
	err := manager.update(context.Background(), &record, update)
	if err == nil || !strings.HasPrefix(err.Error(), managedStorageEngineImageUnavailableCode) {
		t.Fatalf("update error = %v", err)
	}
	for _, call := range touched {
		if !strings.HasSuffix(call, "/update") {
			t.Fatalf("legacy container touched before the image check: %v", touched)
		}
	}
	if record.PublishS3 || record.ContainerID != "running" {
		t.Fatalf("record changed on failure: %#v", record)
	}
}

func TestManagedStorageHandleRejectsEngineMismatch(t *testing.T) {
	manager := &managedStorageManager{root: t.TempDir(), logger: slog.Default()}
	if err := os.MkdirAll(filepath.Join(manager.root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-4111-8111-111111111111"
	if err := manager.saveRecord(managedStorageRecord{ID: id}); err != nil {
		t.Fatal(err)
	}
	update := managedStorageCommand{Version: 2, Engine: managedStorageEngineSeaweedFS}
	if _, err := manager.handle(context.Background(), "update", id, encodeManagedStorageCommand(t, update)); err == nil || !strings.Contains(err.Error(), "engine mismatch") {
		t.Fatalf("SeaweedFS update of a MinIO record = %v", err)
	}
	iam := managedStorageCommand{Version: 1, Engine: managedStorageEngineSeaweedFS, IAM: &managedStorageIAM{Action: "list_keys"}}
	if _, err := manager.handle(context.Background(), "iam_list_keys", id, encodeManagedStorageCommand(t, iam)); err == nil || !strings.Contains(err.Error(), "engine mismatch") {
		t.Fatalf("SeaweedFS IAM on a MinIO record = %v", err)
	}
}

const gatewayBucketPolicy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::alpha","arn:aws:s3:::beta.logs"]},{"Effect":"Allow","Action":["s3:DeleteObject","s3:GetObject","s3:PutObject"],"Resource":["arn:aws:s3:::alpha/*","arn:aws:s3:::beta.logs/*"]}]}`

func TestSeaweedFSPolicyAllowsOnlyGatewayShape(t *testing.T) {
	for _, policy := range []string{
		gatewayBucketPolicy,
		`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::*"},{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::*/*"]}]}`,
	} {
		if err := validateSeaweedFSPolicy(policy); err != nil {
			t.Fatalf("gateway policy rejected: %v", err)
		}
	}
	for name, policy := range map[string]string{
		"empty":            ``,
		"list all buckets": `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListAllMyBuckets"],"Resource":["arn:aws:s3:::*"]}]}`,
		"admin wildcard":   `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::*"]}]}`,
		"deny":             `{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/*"]}]}`,
		"object prefix":    `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/private/*"]}]}`,
		"bad bucket":       `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::Alpha/*"]}]}`,
		"wildcard bucket":  `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alp*/*"]}]}`,
		"condition":        `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/*"],"Condition":{}}]}`,
		"old version":      `{"Version":"2008-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/*"]}]}`,
		"not json":         `{`,
	} {
		if err := validateSeaweedFSPolicy(policy); err == nil {
			t.Fatalf("%s policy accepted", name)
		}
	}
}

func TestSeaweedFSCreateKeyValidation(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	valid := managedStorageIAM{Action: "create_key", Principal: "gw-7f0c2d1e-5b8a-4c11-9d3e-0a1b2c3d4e5f", Policy: gatewayBucketPolicy, TargetAccessKey: "GWKEY0123456789ABCDEF", TargetSecretKey: "secret-0123456789"}
	if _, err := validateSeaweedFSCreateKey(valid, now); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	longest := valid
	longest.Principal = "gw-" + strings.Repeat("a", 61)
	if _, err := validateSeaweedFSCreateKey(longest, now); err != nil {
		t.Fatalf("64-character principal rejected: %v", err)
	}
	expiring := valid
	expiring.ExpiresAt = now.Add(time.Hour).Format(time.RFC3339)
	plan, err := validateSeaweedFSCreateKey(expiring, now)
	if err != nil || plan.ExpiresAt == nil || !plan.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expiring key plan = %#v err = %v", plan, err)
	}
	for name, mutate := range map[string]func(*managedStorageIAM){
		"root principal":  func(i *managedStorageIAM) { i.Principal = seaweedfsRootIdentity },
		"no prefix":       func(i *managedStorageIAM) { i.Principal = "alice" },
		"long principal":  func(i *managedStorageIAM) { i.Principal = "gw-" + strings.Repeat("a", 62) },
		"principal chars": func(i *managedStorageIAM) { i.Principal = "gw-a/b" },
		"key alone":       func(i *managedStorageIAM) { i.TargetSecretKey = "" },
		"key charset":     func(i *managedStorageIAM) { i.TargetAccessKey = "GW-KEY" },
		"short secret":    func(i *managedStorageIAM) { i.TargetSecretKey = "short" },
		"past expiry":     func(i *managedStorageIAM) { i.ExpiresAt = now.Add(-time.Minute).Format(time.RFC3339) },
		"bad expiry":      func(i *managedStorageIAM) { i.ExpiresAt = "tomorrow" },
		"no policy":       func(i *managedStorageIAM) { i.Policy = "" },
		"long name":       func(i *managedStorageIAM) { i.Name = strings.Repeat("n", 129) },
	} {
		input := valid
		mutate(&input)
		if _, err := validateSeaweedFSCreateKey(input, now); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestSigV4MatchesAWSReferenceExample(t *testing.T) {
	// AWS General Reference, "Signature Version 4 signing process" example:
	// GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08
	request, _ := http.NewRequest(http.MethodGet, "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", nil)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	signSigV4(request, sigV4EmptyBodyHash, "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "us-east-1", "iam", time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
	if got := request.Header.Get("Authorization"); got != want {
		t.Fatalf("authorization = %s", got)
	}
}

func TestSigV4MatchesMinioSigner(t *testing.T) {
	// Cross-check the S3 service form against minio-go's signer (it ignores
	// Content-Type, so the request carries only x-amz headers).
	request, _ := http.NewRequest(http.MethodGet, "http://172.18.0.2:9000/alpha/object%20name?list-type=2&prefix=a%2Fb", nil)
	request.Header.Set(sigV4ContentHashKey, sigV4EmptyBodyHash)
	request.Header.Set("X-Amz-Date", time.Now().UTC().Format(sigV4TimeFormat))
	reference := signer.SignV4(*request.Clone(context.Background()), "GWKEY0001", "secret-0123456789", "", "us-east-1")
	amzDate, _ := time.Parse(sigV4TimeFormat, reference.Header.Get("X-Amz-Date"))
	signSigV4(request, sigV4EmptyBodyHash, "GWKEY0001", "secret-0123456789", "us-east-1", "s3", amzDate)
	if request.Header.Get("Authorization") != reference.Header.Get("Authorization") {
		t.Fatalf("authorization\n got %s\nwant %s", request.Header.Get("Authorization"), reference.Header.Get("Authorization"))
	}
}

func TestParseSeaweedFSIAMErrorFormats(t *testing.T) {
	iamErr := parseSeaweedFSIAMError(404, []byte(`<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>missing</Message></Error></ErrorResponse>`))
	if !isSeaweedFSNoSuchEntity(iamErr) || !strings.Contains(iamErr.Error(), "missing") {
		t.Fatalf("IAM error = %v", iamErr)
	}
	s3Err := parseSeaweedFSIAMError(403, []byte(`<Error><Code>InvalidAccessKeyId</Code><Message>unknown key</Message></Error>`))
	var typed *seaweedfsIAMError
	if !errors.As(s3Err, &typed) || typed.Code != "InvalidAccessKeyId" || isSeaweedFSNoSuchEntity(s3Err) {
		t.Fatalf("S3 error = %#v", s3Err)
	}
	if empty := parseSeaweedFSIAMError(500, nil); !strings.Contains(empty.Error(), "Internal Server Error") {
		t.Fatalf("empty error = %v", empty)
	}
}

// fakeSeaweedFSIAM models the embedded IAM behaviour verified against 4.47:
// orphaned inline policies of deleted users, DeleteUser conflicts while
// service accounts exist, NoSuchEntity on missing users.
type fakeSeaweedFSIAM struct {
	mu       sync.Mutex
	calls    []string
	users    map[string]bool
	policies map[string]map[string]string
	keys     map[string][]string
	accounts map[string][]string
	secrets  map[string]string
	fail     map[string]bool
	params   map[string]url.Values
}

func newFakeSeaweedFSIAM() *fakeSeaweedFSIAM {
	return &fakeSeaweedFSIAM{users: map[string]bool{}, policies: map[string]map[string]string{}, keys: map[string][]string{}, accounts: map[string][]string{}, secrets: map[string]string{}, fail: map[string]bool{}, params: map[string]url.Values{}}
}

func (f *fakeSeaweedFSIAM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	authorization := r.Header.Get("Authorization")
	if r.Method == http.MethodGet {
		key := strings.TrimPrefix(strings.SplitN(authorization, "/", 2)[0], "AWS4-HMAC-SHA256 Credential=")
		f.calls = append(f.calls, "ListBuckets:"+key)
		if _, ok := f.secrets[key]; !ok || !strings.Contains(authorization, "/s3/aws4_request") {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<Error><Code>InvalidAccessKeyId</Code><Message>unknown</Message></Error>`))
			return
		}
		_, _ = w.Write([]byte(`<ListAllMyBucketsResult/>`))
		return
	}
	if !strings.Contains(authorization, "Credential=root-access/") || !strings.Contains(authorization, "/iam/aws4_request") {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<Error><Code>AccessDenied</Code><Message>not root</Message></Error>`))
		return
	}
	body, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(body))
	action := form.Get("Action")
	user := form.Get("UserName")
	f.calls = append(f.calls, action)
	f.params[action] = form
	missing := func() {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>missing</Message></Error></ErrorResponse>`))
	}
	if f.fail[action] {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`<ErrorResponse><Error><Code>ServiceFailure</Code><Message>injected</Message></Error></ErrorResponse>`))
		return
	}
	members := func(tag string, values []string) string {
		var out strings.Builder
		for _, value := range values {
			out.WriteString("<member><" + tag + ">" + value + "</" + tag + "></member>")
		}
		return out.String()
	}
	switch action {
	case "GetUser":
		if !f.users[user] {
			missing()
			return
		}
		_, _ = w.Write([]byte(`<GetUserResponse/>`))
	case "CreateUser":
		f.users[user] = true
		_, _ = w.Write([]byte(`<CreateUserResponse/>`))
	case "PutUserPolicy":
		if f.policies[user] == nil {
			f.policies[user] = map[string]string{}
		}
		f.policies[user][form.Get("PolicyName")] = form.Get("PolicyDocument")
		_, _ = w.Write([]byte(`<PutUserPolicyResponse/>`))
	case "ListUserPolicies":
		names := []string{}
		for name := range f.policies[user] {
			names = append(names, name)
		}
		var out strings.Builder
		for _, name := range names {
			out.WriteString("<member>" + name + "</member>")
		}
		_, _ = w.Write([]byte(`<ListUserPoliciesResponse><ListUserPoliciesResult><PolicyNames>` + out.String() + `</PolicyNames></ListUserPoliciesResult></ListUserPoliciesResponse>`))
	case "DeleteUserPolicy":
		if !f.users[user] {
			missing()
			return
		}
		delete(f.policies[user], form.Get("PolicyName"))
		_, _ = w.Write([]byte(`<DeleteUserPolicyResponse/>`))
	case "CreateAccessKey":
		key, secret := form.Get("AccessKeyId"), form.Get("SecretAccessKey")
		if key == "" {
			key, secret = "AKIAGENERATED0000001", "generated-secret-0000000000000000000000000"
		}
		f.keys[user] = append(f.keys[user], key)
		f.secrets[key] = secret
		_, _ = w.Write([]byte(`<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>` + key + `</AccessKeyId><SecretAccessKey>` + secret + `</SecretAccessKey><UserName>` + user + `</UserName></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`))
	case "CreateServiceAccount":
		parent := form.Get("ParentUser")
		key := "ABIASERVICE00000001"
		f.accounts[parent] = append(f.accounts[parent], key)
		f.secrets[key] = "service-secret"
		_, _ = w.Write([]byte(`<CreateServiceAccountResponse><CreateServiceAccountResult><ServiceAccount><ServiceAccountId>sa:` + parent + `:1</ServiceAccountId><ParentUser>` + parent + `</ParentUser><AccessKeyId>` + key + `</AccessKeyId><SecretAccessKey>service-secret</SecretAccessKey></ServiceAccount></CreateServiceAccountResult></CreateServiceAccountResponse>`))
	case "ListServiceAccounts":
		parent := form.Get("ParentUser")
		var out strings.Builder
		for _, key := range f.accounts[parent] {
			out.WriteString(`<member><ServiceAccountId>sa:` + parent + `:1</ServiceAccountId><ParentUser>` + parent + `</ParentUser><AccessKeyId>` + key + `</AccessKeyId><Expiration>2026-09-26T00:00:00Z</Expiration></member>`)
		}
		_, _ = w.Write([]byte(`<ListServiceAccountsResponse><ListServiceAccountsResult><ServiceAccounts>` + out.String() + `</ServiceAccounts></ListServiceAccountsResult></ListServiceAccountsResponse>`))
	case "DeleteServiceAccount":
		parent := strings.Split(form.Get("ServiceAccountId"), ":")[1]
		for _, key := range f.accounts[parent] {
			delete(f.secrets, key)
		}
		delete(f.accounts, parent)
		_, _ = w.Write([]byte(`<DeleteServiceAccountResponse/>`))
	case "ListAccessKeys":
		_, _ = w.Write([]byte(`<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata>` + members("AccessKeyId", f.keys[user]) + `</AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>`))
	case "DeleteAccessKey":
		key := form.Get("AccessKeyId")
		delete(f.secrets, key)
		kept := []string{}
		for _, existing := range f.keys[user] {
			if existing != key {
				kept = append(kept, existing)
			}
		}
		f.keys[user] = kept
		_, _ = w.Write([]byte(`<DeleteAccessKeyResponse/>`))
	case "DeleteUser":
		if !f.users[user] {
			missing()
			return
		}
		if len(f.accounts[user]) > 0 {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`<ErrorResponse><Error><Code>DeleteConflict</Code><Message>service accounts</Message></Error></ErrorResponse>`))
			return
		}
		for _, key := range f.keys[user] {
			delete(f.secrets, key)
		}
		delete(f.keys, user)
		delete(f.users, user) // inline policies are kept, as SeaweedFS does
		_, _ = w.Write([]byte(`<DeleteUserResponse/>`))
	case "ListUsers":
		names := []string{seaweedfsRootIdentity}
		for name := range f.users {
			names = append(names, name)
		}
		_, _ = w.Write([]byte(`<ListUsersResponse><ListUsersResult><Users>` + members("UserName", names) + `</Users></ListUsersResult></ListUsersResponse>`))
	default:
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`<ErrorResponse><Error><Code>InvalidAction</Code><Message>` + action + `</Message></Error></ErrorResponse>`))
	}
}

func newFakeSeaweedFSIAMClient(t *testing.T, fake *fakeSeaweedFSIAM) *seaweedfsIAMClient {
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return &seaweedfsIAMClient{endpoint: server.URL, accessKey: "root-access", secretKey: "root-secret", client: server.Client(), now: time.Now}
}

func TestSeaweedFSIAMCreateListRemoveKey(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	principal := "gw-key-1"
	// A previous user of the same name left an orphaned inline policy that
	// SeaweedFS would re-attach.
	fake.policies[principal] = map[string]string{"legacy": `{"Version":"2012-10-17","Statement":[]}`}
	client := newFakeSeaweedFSIAMClient(t, fake)
	raw, err := client.createKey(context.Background(), managedStorageIAM{Action: "create_key", Principal: principal, Policy: gatewayBucketPolicy, TargetAccessKey: "GWKEY0001", TargetSecretKey: "secret-0123456789"})
	if err != nil {
		t.Fatal(err)
	}
	var created map[string]string
	_ = json.Unmarshal([]byte(raw), &created)
	if created["accessKey"] != "GWKEY0001" || created["accessKeyId"] != "GWKEY0001" || created["secretKey"] != "secret-0123456789" || created["principal"] != principal || created["expiresAt"] != "" {
		t.Fatalf("create response = %s", raw)
	}
	if want := []string{"GetUser", "CreateUser", "PutUserPolicy", "ListUserPolicies", "DeleteUserPolicy", "CreateAccessKey", "ListBuckets:GWKEY0001"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("create calls = %v, want %v", fake.calls, want)
	}
	if !reflect.DeepEqual(fake.policies[principal], map[string]string{seaweedfsInlinePolicyName: gatewayBucketPolicy}) {
		t.Fatalf("policies after create = %v", fake.policies[principal])
	}
	listed, err := client.listKeys(context.Background(), "")
	if err != nil || !strings.Contains(listed, `"accessKeys":["GWKEY0001"]`) || !strings.Contains(listed, `"principal":"gw-key-1"`) || strings.Contains(listed, seaweedfsRootIdentity) {
		t.Fatalf("list = %s err = %v", listed, err)
	}
	fake.calls = nil
	if _, err := client.removeKey(context.Background(), managedStorageIAM{Action: "remove_key", TargetAccessKey: "GWKEY0001"}); err != nil {
		t.Fatal(err)
	}
	if fake.users[principal] || len(fake.policies[principal]) != 0 || fake.secrets["GWKEY0001"] != "" {
		t.Fatalf("principal survived removal: users=%v policies=%v", fake.users, fake.policies)
	}
	if _, err := client.removeKey(context.Background(), managedStorageIAM{Action: "remove_key", Principal: principal}); err != nil {
		t.Fatalf("idempotent removal: %v", err)
	}
}

func TestSeaweedFSIAMExpiringKeyUsesServiceAccount(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	client := newFakeSeaweedFSIAMClient(t, fake)
	expires := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	raw, err := client.createKey(context.Background(), managedStorageIAM{Action: "create_key", Principal: "gw-expiring", Name: "CI key", Policy: gatewayBucketPolicy, ExpiresAt: expires.Format(time.RFC3339), TargetAccessKey: "IGNORED0001", TargetSecretKey: "ignored-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"accessKey":"ABIASERVICE00000001"`) || !strings.Contains(raw, `"expiresAt":"`+expires.Format(time.RFC3339)+`"`) {
		t.Fatalf("expiring create = %s", raw)
	}
	params := fake.params["CreateServiceAccount"]
	if params.Get("ParentUser") != "gw-expiring" || params.Get("Expiration") != strconv.FormatInt(expires.Unix(), 10) || params.Get("Description") != "CI key" {
		t.Fatalf("CreateServiceAccount params = %v", params)
	}
	fake.calls = nil
	if _, err := client.removeKey(context.Background(), managedStorageIAM{Action: "remove_key", Principal: "gw-expiring"}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"GetUser", "ListServiceAccounts", "DeleteServiceAccount", "ListUserPolicies", "DeleteUserPolicy", "ListAccessKeys", "DeleteUser"}; !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("remove calls = %v, want %v", fake.calls, want)
	}
}

func TestSeaweedFSIAMFailedCreateLeavesNoPrincipal(t *testing.T) {
	fake := newFakeSeaweedFSIAM()
	fake.fail["CreateAccessKey"] = true
	client := newFakeSeaweedFSIAMClient(t, fake)
	if _, err := client.createKey(context.Background(), managedStorageIAM{Action: "create_key", Principal: "gw-broken", Policy: gatewayBucketPolicy}); err == nil {
		t.Fatal("failed create reported success")
	}
	if fake.users["gw-broken"] || len(fake.policies["gw-broken"]) != 0 {
		t.Fatalf("failed create left principal state: users=%v policies=%v", fake.users, fake.policies)
	}
}
