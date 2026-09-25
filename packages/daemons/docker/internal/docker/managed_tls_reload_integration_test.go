//go:build linux

package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// TestManagedTLSReloadEnginesE2E renews the certificate of real PostgreSQL,
// Redis, ClickHouse, legacy MinIO and SeaweedFS containers through the
// daemon's reload_tls/probe_tls handlers and checks that each engine serves
// the new leaf without a restart.
//
// It runs inside a Linux container that shares a Docker network with the
// engines (so the daemon's private-network probe is real) and a named volume
// with them (so the daemon's staged files are what the engines read):
//
//	docker volume create gwtls-e2e && docker run --rm --name gwtls-runner \
//	  -v /var/run/docker.sock:/var/run/docker.sock -v gwtls-e2e:/srv/gwtls \
//	  -v "$PWD/packages/daemons:/src" -v "$(go env GOMODCACHE):/go/pkg/mod:ro" -w /src/docker \
//	  -e GOPROXY=off -e CGO_ENABLED=0 -e GATEWAY_MANAGED_TLS_RELOAD_E2E=1 \
//	  -e GATEWAY_MANAGED_TLS_RELOAD_E2E_ROOT=/srv/gwtls -e GATEWAY_MANAGED_TLS_RELOAD_E2E_VOLUME=gwtls-e2e \
//	  -e GATEWAY_MANAGED_TLS_RELOAD_E2E_SELF=gwtls-runner golang:1.26 \
//	  go test ./internal/docker/ -run TestManagedTLSReloadEnginesE2E -v
func TestManagedTLSReloadEnginesE2E(t *testing.T) {
	if os.Getenv("GATEWAY_MANAGED_TLS_RELOAD_E2E") != "1" {
		t.Skip("set GATEWAY_MANAGED_TLS_RELOAD_E2E=1 in a Linux runner container (see the test doc)")
	}
	root := os.Getenv("GATEWAY_MANAGED_TLS_RELOAD_E2E_ROOT")
	volume := os.Getenv("GATEWAY_MANAGED_TLS_RELOAD_E2E_VOLUME")
	self := os.Getenv("GATEWAY_MANAGED_TLS_RELOAD_E2E_SELF")
	if root == "" || volume == "" || self == "" {
		t.Fatal("GATEWAY_MANAGED_TLS_RELOAD_E2E_ROOT, _VOLUME and _SELF are required")
	}
	socket := os.Getenv("GATEWAY_MANAGED_TLS_RELOAD_E2E_SOCKET")
	if socket == "" {
		socket = "unix:///var/run/docker.sock"
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := NewClient(socket, t.TempDir(), logger)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	suffix := strconv.FormatInt(time.Now().UnixNano()%1_000_000, 10)
	networkName := "gwtls-e2e-" + suffix
	if _, err := client.cli.NetworkCreate(ctx, networkName, mobyclient.NetworkCreateOptions{Driver: "bridge"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.cli.NetworkConnect(ctx, networkName, mobyclient.NetworkConnectOptions{Container: self, EndpointConfig: &network.EndpointSettings{}}); err != nil {
		t.Fatal(err)
	}
	var containers []string
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 2*time.Minute)
		defer done()
		for _, id := range containers {
			_ = client.RemoveContainer(cleanup, id, true)
		}
		_, _ = client.cli.NetworkDisconnect(cleanup, networkName, mobyclient.NetworkDisconnectOptions{Container: self, Force: true})
		_, _ = client.cli.NetworkRemove(cleanup, networkName, mobyclient.NetworkRemoveOptions{})
	}()
	start := func(t *testing.T, name string, config *container.Config, mounts []mount.Mount, tmpfs map[string]string) string {
		t.Helper()
		if present, err := client.localImagePresent(ctx, config.Image); err != nil || !present {
			if err := client.PullImage(ctx, config.Image, ""); err != nil {
				t.Fatalf("pull %s: %v", config.Image, err)
			}
		}
		created, err := client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
			Name: name + "-" + suffix, Config: config,
			HostConfig:       &container.HostConfig{Mounts: mounts, Tmpfs: tmpfs},
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}},
		})
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		containers = append(containers, created.ID)
		if _, err := client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
			t.Fatalf("start %s: %v", name, err)
		}
		return created.ID
	}
	startedAt := func(t *testing.T, id string) string {
		t.Helper()
		inspect, err := client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
		if err != nil || inspect.Container.State == nil {
			t.Fatalf("inspect %s: %v", id, err)
		}
		return inspect.Container.State.StartedAt + "/" + strconv.Itoa(inspect.Container.RestartCount)
	}
	subpathMount := func(subpath, target string) mount.Mount {
		return mount.Mount{Type: mount.TypeVolume, Source: volume, Target: target, ReadOnly: true, VolumeOptions: &mount.VolumeOptions{Subpath: subpath}}
	}
	waitServed := func(t *testing.T, probe func() (servedCertificate, error), expected string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Minute)
		var last servedCertificate
		var lastErr error
		for time.Now().Before(deadline) {
			last, lastErr = probe()
			if lastErr == nil && last.FingerprintSHA256 == expected {
				return
			}
			time.Sleep(time.Second)
		}
		t.Fatalf("initial certificate never served: last=%s err=%v", last.FingerprintSHA256, lastErr)
	}
	decode := func(t *testing.T, detail string) tlsReloadResult {
		t.Helper()
		var result tlsReloadResult
		if err := json.Unmarshal([]byte(detail), &result); err != nil {
			t.Fatalf("decode %s: %v", detail, err)
		}
		return result
	}
	const password = "e2e-owner-password-0123456789"

	databases := &managedDatabaseManager{root: filepath.Join(root, "db-"+suffix), client: client, logger: logger}
	for _, dir := range []string{"records", "tls", "images", "mounts", "config"} {
		if err := os.MkdirAll(filepath.Join(databases.root, dir), 0755); err != nil {
			t.Fatal(err)
		}
	}
	databaseEngines := []struct {
		engine, image string
		owner         string
		config        func(id string) (*container.Config, []mount.Mount)
	}{
		{
			engine: "postgres", owner: "app_owner",
			image: envOr("GATEWAY_MANAGED_TLS_RELOAD_E2E_POSTGRES_IMAGE", "docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"),
			config: func(id string) (*container.Config, []mount.Mount) {
				return &container.Config{
					Env: []string{"POSTGRES_USER=app_owner", "POSTGRES_PASSWORD=" + password, "POSTGRES_DB=app", "PGDATA=/var/lib/postgresql/data/pgdata"},
					Cmd: []string{"postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/run/gateway-tls/cert.pem", "-c", "ssl_key_file=/run/gateway-tls/key.pem"},
				}, nil
			},
		},
		{
			engine: "redis", owner: "default",
			image: envOr("GATEWAY_MANAGED_TLS_RELOAD_E2E_REDIS_IMAGE", "docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236"),
			config: func(id string) (*container.Config, []mount.Mount) {
				return &container.Config{Cmd: []string{"redis-server", "--requirepass", password, "--port", "6379", "--tls-port", "6380",
					"--tls-cert-file", "/run/gateway-tls/cert.pem", "--tls-key-file", "/run/gateway-tls/key.pem", "--tls-ca-cert-file", "/run/gateway-tls/ca.pem", "--tls-auth-clients", "no"}}, nil
			},
		},
		{
			engine: "clickhouse", owner: "app_owner",
			image: envOr("GATEWAY_MANAGED_TLS_RELOAD_E2E_CLICKHOUSE_IMAGE", "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"),
			config: func(id string) (*container.Config, []mount.Mount) {
				directory := filepath.Join(databases.root, "config", id)
				if err := os.MkdirAll(directory, 0755); err != nil {
					t.Fatal(err)
				}
				tlsConfig := `<clickhouse><listen_host>0.0.0.0</listen_host><https_port>8443</https_port><tcp_port_secure>9440</tcp_port_secure><openSSL><server><certificateFile>/run/gateway-tls/cert.pem</certificateFile><privateKeyFile>/run/gateway-tls/key.pem</privateKeyFile></server></openSSL></clickhouse>`
				if err := writeClickHouseConfig(filepath.Join(directory, "gateway-tls.xml"), tlsConfig); err != nil {
					t.Fatal(err)
				}
				return &container.Config{Env: []string{"CLICKHOUSE_USER=app_owner", "CLICKHOUSE_PASSWORD=" + password, "CLICKHOUSE_DB=app", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1"}},
					[]mount.Mount{subpathMount(filepath.Join("db-"+suffix, "config", id), "/etc/clickhouse-server/config.d")}
			},
		},
	}
	for _, engine := range databaseEngines {
		t.Run(engine.engine, func(t *testing.T) {
			id := "tlse2e_" + engine.engine + "_" + suffix
			first, second := newTestTLSMaterial(t), newTestTLSMaterial(t)
			record := managedDatabaseRecord{
				ID: id, Type: engine.engine, NetworkName: networkName, TLSEnabled: true, TLSCertificateID: "certificate_first",
				ImagePath: filepath.Join(databases.root, "images", id+".img"), MountPath: filepath.Join(databases.root, "mounts", id),
			}
			input := managedDatabaseCommand{Type: engine.engine, OwnerUsername: engine.owner, OwnerPassword: password, DatabaseName: "app",
				TLSEnabled: true, TLSCertificatePEM: first.CertPEM, TLSPrivateKeyPEM: first.KeyPEM, TLSCACertificatePEM: first.CAPEM, TLSCertificateID: "certificate_first"}
			if err := writeManagedDatabaseTLS(databases.tlsDirectory(record), input); err != nil {
				t.Fatal(err)
			}
			config, mounts := engine.config(id)
			config.Image = engine.image
			config.Labels = map[string]string{managedDatabaseLabel: id, managedDatabaseTypeTag: engine.engine}
			mounts = append(mounts, subpathMount(filepath.Join("db-"+suffix, "tls", id), "/run/gateway-tls"))
			record.ContainerID = start(t, engine.engine, config, mounts, nil)
			if err := databases.saveRecord(record); err != nil {
				t.Fatal(err)
			}
			if err := databases.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
				t.Fatal(err)
			}
			waitServed(t, func() (servedCertificate, error) { return databases.probeTLS(ctx, record) }, first.Fingerprint)
			before := startedAt(t, record.ContainerID)

			payload, _ := json.Marshal(managedDatabaseTLSReloadCommand{
				Type: engine.engine, OwnerUsername: engine.owner, OwnerPassword: password, DatabaseName: "app",
				TLSCertificatePEM: second.CertPEM, TLSPrivateKeyPEM: second.KeyPEM, TLSCACertificatePEM: second.CAPEM, TLSCertificateID: "certificate_second",
			})
			began := time.Now()
			detail, err := databases.handle(ctx, "reload_tls", id, string(payload))
			if err != nil {
				t.Fatal(err)
			}
			result := decode(t, detail)
			t.Logf("%s reload_tls -> %s in %s", engine.engine, detail, time.Since(began).Round(time.Millisecond))
			if result.Status != tlsReloadStatusReloaded || result.Restarted || result.FingerprintSHA256 != second.Fingerprint {
				t.Fatalf("result = %+v", result)
			}
			if after := startedAt(t, record.ContainerID); after != before {
				t.Fatalf("container restarted: %s -> %s", before, after)
			}
			saved, _ := databases.loadRecord(id)
			if saved.TLSCertificateID != "certificate_second" {
				t.Fatalf("recorded certificate id = %q", saved.TLSCertificateID)
			}
			probed, err := databases.handle(ctx, "probe_tls", id, "")
			if err != nil || !strings.Contains(probed, second.Fingerprint) {
				t.Fatalf("probe_tls = %s err=%v", probed, err)
			}
			if err := databases.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
				t.Fatalf("engine unhealthy after reload: %v", err)
			}
		})
	}

	storage := &managedStorageManager{root: filepath.Join(root, "storage-"+suffix), client: client, logger: logger}
	for _, dir := range []string{"storage/records", "storage/tls", "storage/seaweedfs"} {
		if err := os.MkdirAll(filepath.Join(storage.root, dir), 0755); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("minio", func(t *testing.T) {
		id := "33333333-3333-4333-8333-" + fmt.Sprintf("%012d", time.Now().UnixNano()%1_000_000_000_000)
		first, second := newTestTLSMaterial(t), newTestTLSMaterial(t)
		record := managedStorageRecord{ID: id, NetworkName: networkName, TLSEnabled: true, TLSServerName: "localhost", MemberCount: 1, DesiredRunning: true}
		if _, err := storage.stageTLS(record, managedStorageTLS{CertPEM: first.CertPEM, KeyPEM: first.KeyPEM, CAPEM: first.CAPEM, ServerName: "localhost"}); err != nil {
			t.Fatal(err)
		}
		record.ContainerID = start(t, "minio", &container.Config{
			Image:  envOr("GATEWAY_MANAGED_TLS_RELOAD_E2E_MINIO_IMAGE", trustedMinioImage),
			Env:    []string{"MINIO_ROOT_USER=e2e-root", "MINIO_ROOT_PASSWORD=" + password},
			Cmd:    []string{"server", "--address", ":9000", "--console-address", ":9001", "--certs-dir", "/run/gateway-minio-certs", "/data"},
			Labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0"},
		}, []mount.Mount{subpathMount(filepath.Join("storage-"+suffix, "storage", "tls", id+"-0"), "/run/gateway-minio-certs")}, nil)
		if err := storage.saveRecord(record); err != nil {
			t.Fatal(err)
		}
		waitServed(t, func() (servedCertificate, error) { return storage.probeTLS(ctx, record) }, first.Fingerprint)
		before := startedAt(t, record.ContainerID)
		payload, _ := json.Marshal(managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: second.CertPEM, KeyPEM: second.KeyPEM, CAPEM: second.CAPEM, ServerName: "localhost"}})
		began := time.Now()
		detail, err := storage.handle(ctx, "reload_tls", id, string(payload))
		if err != nil {
			t.Fatal(err)
		}
		result := decode(t, detail)
		t.Logf("minio reload_tls -> %s in %s", detail, time.Since(began).Round(time.Millisecond))
		if result.Status != tlsReloadStatusReloaded || result.Restarted || result.Method != tlsReloadMethodSignal {
			t.Fatalf("result = %+v", result)
		}
		if after := startedAt(t, record.ContainerID); after != before {
			t.Fatalf("MinIO restarted on SIGHUP: %s -> %s", before, after)
		}
	})
	t.Run("seaweedfs", func(t *testing.T) {
		id := "44444444-4444-4444-8444-" + fmt.Sprintf("%012d", time.Now().UnixNano()%1_000_000_000_000)
		first, second := newTestTLSMaterial(t), newTestTLSMaterial(t)
		record := managedStorageRecord{ID: id, Engine: managedStorageEngineSeaweedFS, NetworkName: networkName, TLSEnabled: true, TLSServerName: "localhost",
			MemberCount: 1, StorageBytes: minimumStorageBytes, MemoryBytes: minimumSeaweedFSMemoryBytes, DesiredRunning: true}
		command := validSeaweedFSCommand()
		command.TLS = &managedStorageTLS{CertPEM: first.CertPEM, KeyPEM: first.KeyPEM, CAPEM: first.CAPEM, ServerName: "localhost"}
		if _, err := storage.stageSeaweedFS(record, command); err != nil {
			t.Fatal(err)
		}
		record.ContainerID = start(t, "seaweedfs", &container.Config{
			Image: envOr("GATEWAY_MANAGED_TLS_RELOAD_E2E_SEAWEEDFS_IMAGE", seaweedfsUpstreamImage),
			User:  fmt.Sprintf("%d:%d", seaweedfsRuntimeUID, seaweedfsRuntimeGID), Entrypoint: []string{"/usr/bin/weed"}, Cmd: seaweedfsCommand(record),
			// A short interval keeps the test fast; production uses seaweedfsTLSRefreshInterval.
			Env:    []string{"GOMEMLIMIT=400MiB", "WEED_TLS_CERT_REFRESH_INTERVAL=5s"},
			Labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0", managedStorageEngineLabel: managedStorageEngineSeaweedFS},
		}, []mount.Mount{subpathMount(filepath.Join("storage-"+suffix, "storage", "seaweedfs", id+"-0"), seaweedfsContainerRoot)},
			map[string]string{"/data": "rw,uid=1000,gid=1000"})
		if err := storage.saveRecord(record); err != nil {
			t.Fatal(err)
		}
		waitServed(t, func() (servedCertificate, error) { return storage.probeTLS(ctx, record) }, first.Fingerprint)
		before := startedAt(t, record.ContainerID)
		payload, _ := json.Marshal(managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: second.CertPEM, KeyPEM: second.KeyPEM, CAPEM: second.CAPEM, ServerName: "localhost"}})
		began := time.Now()
		detail, err := storage.handle(ctx, "reload_tls", id, string(payload))
		if err != nil {
			t.Fatal(err)
		}
		result := decode(t, detail)
		t.Logf("seaweedfs reload_tls -> %s in %s", detail, time.Since(began).Round(time.Millisecond))
		if result.Status != tlsReloadStatusReloaded || result.Restarted || result.Method != tlsReloadMethodFileWatch || result.ReloadIntervalSeconds != 5 {
			t.Fatalf("result = %+v", result)
		}
		if after := startedAt(t, record.ContainerID); after != before {
			t.Fatalf("SeaweedFS restarted: %s -> %s", before, after)
		}
		// Repeating the delivery is idempotent: nothing is rewritten and the
		// served leaf is confirmed immediately.
		detail, err = storage.handle(ctx, "reload_tls", id, string(payload))
		if err != nil || decode(t, detail).Status != tlsReloadStatusReloaded {
			t.Fatalf("repeated reload = %s err=%v", detail, err)
		}
	})
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
