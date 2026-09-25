//go:build linux

package docker

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/moby/moby/api/pkg/stdcopy"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// TestManagedStorageSeaweedFSE2E drives the real allocator, image pull
// (GHCR mirror, then Docker Hub), SeaweedFS runtime and IAM through the same
// daemon entry points the backend uses. It needs a privileged Linux Docker
// host with loop devices and e2fsprogs, like TestManagedStorageLifecycleE2E.
func TestManagedStorageSeaweedFSE2E(t *testing.T) {
	if os.Getenv("GATEWAY_MANAGED_STORAGE_SEAWEEDFS_E2E") != "1" {
		t.Skip("set GATEWAY_MANAGED_STORAGE_SEAWEEDFS_E2E=1 on a privileged Linux runner")
	}
	root := os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_ROOT")
	socket := os.Getenv("GATEWAY_MANAGED_STORAGE_E2E_SOCKET")
	if root == "" || socket == "" {
		t.Fatal("GATEWAY_MANAGED_STORAGE_E2E_ROOT and GATEWAY_MANAGED_STORAGE_E2E_SOCKET are required")
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	client, err := NewClient(socket, filepath.Join(root, "state"), logger)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if err := client.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	manager, err := newManagedStorageManager(&config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: root}}}, client, logger)
	if err != nil {
		t.Fatal(err)
	}
	const serverName = "storage.gateway.test"
	caPEM, certPEM, keyPEM := seaweedfsE2ECertificates(t, serverName)
	tlsMaterial := &managedStorageTLS{CertPEM: certPEM, KeyPEM: keyPEM, CAPEM: caPEM, ServerName: serverName}

	id := "44444444-4444-4444-8444-444444444444"
	input := validSeaweedFSCommand()
	input.OperationID = "55555555-5555-4555-8555-555555555555"
	input.Resources.NanoCPUs = 1_000_000_000
	input.TLS = tlsMaterial
	rootKey, rootSecret := input.RootCredentials.AccessKey, input.RootCredentials.SecretKey

	start := time.Now()
	created, err := manager.handle(ctx, "create", id, encodeManagedStorageCommand(t, input))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	record, err := manager.loadRecord(id)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := manager.handle(context.Background(), "delete_data", id, ""); err != nil {
			t.Errorf("cleanup delete_data: %v", err)
		}
	}()
	t.Logf("create -> %s in %s using image %s", created, time.Since(start).Round(time.Second), record.Image)
	if !isTrustedSeaweedFSImage(record.Image) || !strings.Contains(created, `"status":"ready"`) || !strings.Contains(created, `"engine":"seaweedfs"`) {
		t.Fatalf("create detail = %s image = %s", created, record.Image)
	}

	inspect, err := client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if inspect.Container.Config.User != "1000:1000" || inspect.Container.State.Health == nil || inspect.Container.State.Health.Status != "healthy" {
		t.Fatalf("runtime user %q health %#v", inspect.Container.Config.User, inspect.Container.State.Health)
	}
	if len(inspect.Container.HostConfig.PortBindings) != 0 {
		t.Fatalf("private storage published ports: %v", inspect.Container.HostConfig.PortBindings)
	}
	listening, err := manager.runtimeExec(ctx, record, "netstat -tln")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(listening, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || !strings.HasPrefix(fields[0], "tcp") {
			continue
		}
		address := fields[3]
		// 127.0.0.0/8 includes Docker's embedded DNS listener (127.0.0.11).
		if !strings.HasPrefix(address, "127.") && address != ":::9000" && address != "0.0.0.0:9000" && address != ":::19000" && address != "0.0.0.0:19000" {
			t.Fatalf("unexpected non-loopback listener %s:\n%s", address, listening)
		}
	}
	t.Log("only S3 (9000) and its JWT-guarded gRPC IAM cache (19000) listen beyond loopback")

	transport := seaweedfsE2ETransport(t, caPEM, serverName)
	endpoint := func() string {
		value, err := manager.privateEndpoint(ctx, record)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	s3 := func(accessKey, secretKey string, region string) *minio.Client {
		value, err := minio.New(endpoint(), &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: true, Transport: transport, Region: region, BucketLookup: minio.BucketLookupPath})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}

	// signedStatus sends one raw SigV4 request (minio-go answers
	// GetBucketLocation from its configured region without asking).
	signedStatus := func(accessKey, secretKey, method, path string) int {
		request, err := http.NewRequestWithContext(ctx, method, "https://"+endpoint()+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(sigV4ContentHashKey, sigV4EmptyBodyHash)
		signSigV4(request, sigV4EmptyBodyHash, accessKey, secretKey, "us-east-1", "s3", time.Now())
		response, err := (&http.Client{Transport: transport, Timeout: 10 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}

	t.Run("TLS on 9000", func(t *testing.T) {
		response, err := (&http.Client{Transport: transport, Timeout: 5 * time.Second}).Get("https://" + endpoint() + "/healthz")
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("https healthz = %v %v", response, err)
		}
		response.Body.Close()
		plain, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + endpoint() + "/healthz")
		if err == nil {
			plain.Body.Close()
			if plain.StatusCode == http.StatusOK {
				t.Fatal("plain HTTP served on the TLS port")
			}
		}
		insecure := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "wrong.example", RootCAs: transport.TLSClientConfig.RootCAs}}
		if _, err := (&http.Client{Transport: insecure, Timeout: 5 * time.Second}).Get("https://" + endpoint() + "/healthz"); err == nil {
			t.Fatal("certificate verified for the wrong server name")
		}
	})

	admin := s3(rootKey, rootSecret, "us-east-1")
	for _, bucket := range []string{"alpha", "beta"} {
		if err := admin.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			t.Fatalf("make bucket %s: %v", bucket, err)
		}
	}
	putObject(t, ctx, admin, "alpha", "shared.txt", []byte("alpha data"))
	putObject(t, ctx, admin, "beta", "secret.txt", []byte("beta secret"))

	iam := func(action string, request managedStorageIAM) (string, error) {
		request.Action = strings.TrimPrefix(action, "iam_")
		// The backend sends IAM envelopes as version 1 with engine seaweedfs.
		return manager.handle(ctx, action, id, encodeManagedStorageCommand(t, managedStorageCommand{Version: 1, Engine: managedStorageEngineSeaweedFS, IAM: &request}))
	}
	bucketPolicy := func(bucket string, write bool, location bool) string {
		bucketActions := []string{"s3:ListBucket"}
		if location {
			bucketActions = append([]string{"s3:GetBucketLocation"}, bucketActions...)
		}
		objectActions := []string{"s3:GetObject"}
		if write {
			objectActions = []string{"s3:DeleteObject", "s3:GetObject", "s3:PutObject"}
		}
		raw, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []map[string]any{
			{"Effect": "Allow", "Action": bucketActions, "Resource": []string{"arn:aws:s3:::" + bucket}},
			{"Effect": "Allow", "Action": objectActions, "Resource": []string{"arn:aws:s3:::" + bucket + "/*"}},
		}})
		return string(raw)
	}
	type key struct{ accessKey, secretKey, expiresAt string }
	createKey := func(request managedStorageIAM) key {
		raw, err := iam("iam_create_key", request)
		if err != nil {
			t.Fatalf("create key %s: %v", request.Principal, err)
		}
		var response map[string]string
		if err := json.Unmarshal([]byte(raw), &response); err != nil {
			t.Fatal(err)
		}
		return key{response["accessKey"], response["secretKey"], response["expiresAt"]}
	}

	// Caller-chosen pair in the backend's format: GW + 18 upper-case hex, 40-char base64url secret.
	rw := createKey(managedStorageIAM{Principal: "gw-7f0c2d1e-5b8a-4c11-9d3e-0a1b2c3d4e5f", Policy: bucketPolicy("alpha", true, false), TargetAccessKey: "GW0123456789ABCDEF01", TargetSecretKey: "Zm9vYmFyYmF6cXV4LV9hYmNkZWZnaGlqa2xtbm9w"})
	ro := createKey(managedStorageIAM{Principal: "gw-read-only", Policy: bucketPolicy("alpha", false, true)})
	expires := time.Now().Add(25 * time.Second).UTC().Truncate(time.Second)
	expiring := createKey(managedStorageIAM{Principal: "gw-expiring", Name: "e2e expiring key", Policy: bucketPolicy("alpha", false, false), ExpiresAt: expires.Format(time.RFC3339)})
	if rw.accessKey != "GW0123456789ABCDEF01" || !strings.HasPrefix(ro.accessKey, "AKIA") || expiring.expiresAt == "" {
		t.Fatalf("keys rw=%s ro=%s expiring=%s/%s", rw.accessKey, ro.accessKey, expiring.accessKey, expiring.expiresAt)
	}

	t.Run("scoped read-write key", func(t *testing.T) {
		client := s3(rw.accessKey, rw.secretKey, "us-east-1")
		putObject(t, ctx, client, "alpha", "rw.txt", []byte("written by rw"))
		if got := getObject(t, ctx, client, "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read own bucket = %q", got)
		}
		large := bytes.Repeat([]byte("m"), 24*1024*1024)
		if _, err := client.PutObject(ctx, "alpha", "multipart.bin", bytes.NewReader(large), int64(len(large)), minio.PutObjectOptions{PartSize: 5 * 1024 * 1024}); err != nil {
			t.Fatalf("multipart upload to own bucket: %v", err)
		}
		if n := countObjects(ctx, client, "alpha"); n < 3 {
			t.Fatalf("own listing returned %d objects", n)
		}
		expectDenied(t, "read other bucket", func() error { _, err := readObject(ctx, client, "beta", "secret.txt"); return err })
		expectDenied(t, "list other bucket", func() error { return listError(ctx, client, "beta") })
		expectDenied(t, "write other bucket", func() error { return putError(ctx, client, "beta", "x.txt") })
		expectDenied(t, "create bucket", func() error { return client.MakeBucket(ctx, "gamma", minio.MakeBucketOptions{}) })
		buckets, err := client.ListBuckets(ctx)
		if err != nil || len(buckets) != 1 || buckets[0].Name != "alpha" {
			t.Fatalf("ListBuckets = %v %v", buckets, err)
		}
		// Backend policy without s3:GetBucketLocation: the explicit call is refused ...
		if status := signedStatus(rw.accessKey, rw.secretKey, http.MethodGet, "/alpha?location"); status != http.StatusForbidden {
			t.Fatalf("GetBucketLocation without the action = HTTP %d", status)
		}
		// ... and a client doing its usual region lookup (no region configured) still works,
		// because minio-go treats a refused lookup as the default region.
		lookup := s3(rw.accessKey, rw.secretKey, "")
		if got := getObject(t, ctx, lookup, "alpha", "rw.txt"); got != "written by rw" {
			t.Fatalf("region-lookup client read = %q", got)
		}
	})

	t.Run("read-only key with GetBucketLocation", func(t *testing.T) {
		client := s3(ro.accessKey, ro.secretKey, "us-east-1")
		if got := getObject(t, ctx, client, "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read-only read = %q", got)
		}
		expectDenied(t, "read-only write", func() error { return putError(ctx, client, "alpha", "denied.txt") })
		expectDenied(t, "read-only delete", func() error { return client.RemoveObject(ctx, "alpha", "shared.txt", minio.RemoveObjectOptions{}) })
		if status := signedStatus(ro.accessKey, ro.secretKey, http.MethodGet, "/alpha?location"); status != http.StatusOK {
			t.Fatalf("GetBucketLocation with the action = HTTP %d", status)
		}
		if status := signedStatus(ro.accessKey, ro.secretKey, http.MethodGet, "/beta?location"); status != http.StatusForbidden {
			t.Fatalf("GetBucketLocation of another bucket = HTTP %d", status)
		}
		if status := signedStatus(ro.accessKey, ro.secretKey, http.MethodHead, "/alpha"); status != http.StatusOK {
			t.Fatalf("HeadBucket own = HTTP %d", status)
		}
		if status := signedStatus(ro.accessKey, ro.secretKey, http.MethodHead, "/beta"); status != http.StatusForbidden {
			t.Fatalf("HeadBucket other = HTTP %d", status)
		}
	})

	t.Run("list keys per principal", func(t *testing.T) {
		raw, err := iam("iam_list_keys", managedStorageIAM{})
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{rw.accessKey, ro.accessKey, expiring.accessKey, `"principal":"gw-read-only"`, `"kind":"service_account"`} {
			if !strings.Contains(raw, expected) {
				t.Fatalf("list_keys %s misses %s", raw, expected)
			}
		}
		if strings.Contains(raw, rootKey) || strings.Contains(raw, seaweedfsRootIdentity) {
			t.Fatalf("list_keys exposes the root identity: %s", raw)
		}
	})

	t.Run("root identity cannot be changed through IAM", func(t *testing.T) {
		client, err := manager.seaweedfsIAMClientFor(ctx, record)
		if err != nil {
			t.Fatal(err)
		}
		restrictive := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::alpha/*"]}]}`
		for _, attempt := range []struct {
			action string
			params url.Values
		}{
			{"PutUserPolicy", url.Values{"UserName": {seaweedfsRootIdentity}, "PolicyName": {"takeover"}, "PolicyDocument": {restrictive}}},
			{"CreateAccessKey", url.Values{"UserName": {seaweedfsRootIdentity}, "AccessKeyId": {"ROOTSHADOW0001"}, "SecretAccessKey": {"shadow-secret-0001"}}},
			{"DeleteAccessKey", url.Values{"UserName": {seaweedfsRootIdentity}, "AccessKeyId": {rootKey}}},
			{"DeleteUser", url.Values{"UserName": {seaweedfsRootIdentity}}},
		} {
			err := client.call(ctx, attempt.action, attempt.params, nil)
			t.Logf("%s on the static root identity -> %v", attempt.action, err)
		}
		time.Sleep(2 * time.Second)
		if err := admin.MakeBucket(ctx, "rootcheck", minio.MakeBucketOptions{}); err != nil {
			t.Fatalf("root lost admin after IAM mutations: %v", err)
		}
		if status, err := client.listBucketsStatus(ctx, "ROOTSHADOW0001", "shadow-secret-0001"); err != nil || status == http.StatusOK {
			t.Fatalf("shadow key minted for root authenticates: %d %v", status, err)
		}
	})

	t.Run("non-empty bucket delete is refused", func(t *testing.T) {
		err := admin.RemoveBucket(ctx, "alpha")
		if code := minio.ToErrorResponse(err).Code; code != "BucketNotEmpty" {
			t.Fatalf("RemoveBucket(non-empty) = %v", err)
		}
	})

	t.Run("revoked key is refused", func(t *testing.T) {
		if _, err := iam("iam_remove_key", managedStorageIAM{Principal: "gw-7f0c2d1e-5b8a-4c11-9d3e-0a1b2c3d4e5f", TargetAccessKey: rw.accessKey}); err != nil {
			t.Fatal(err)
		}
		client := s3(rw.accessKey, rw.secretKey, "us-east-1")
		waitFor(t, 15*time.Second, "revoked key refused", func() error {
			_, err := readObject(ctx, client, "alpha", "shared.txt")
			if code := minio.ToErrorResponse(err).Code; code == "InvalidAccessKeyId" || code == "AccessDenied" {
				return nil
			}
			return fmt.Errorf("revoked key still reads: %v", err)
		})
		if _, err := iam("iam_remove_key", managedStorageIAM{Principal: "gw-7f0c2d1e-5b8a-4c11-9d3e-0a1b2c3d4e5f"}); err != nil {
			t.Fatalf("repeated revoke: %v", err)
		}
	})

	t.Run("expired service account is refused", func(t *testing.T) {
		client := s3(expiring.accessKey, expiring.secretKey, "us-east-1")
		if time.Now().Before(expires.Add(-3 * time.Second)) {
			if got := getObject(t, ctx, client, "alpha", "shared.txt"); got != "alpha data" {
				t.Fatalf("expiring key before expiry read = %q", got)
			}
		}
		time.Sleep(time.Until(expires.Add(2 * time.Second)))
		waitFor(t, 20*time.Second, "expired key refused", func() error {
			_, err := readObject(ctx, client, "alpha", "shared.txt")
			if minio.ToErrorResponse(err).Code == "AccessDenied" || minio.ToErrorResponse(err).Code == "InvalidAccessKeyId" {
				return nil
			}
			return fmt.Errorf("expired key still reads: %v", err)
		})
	})

	t.Run("keys and data survive restart", func(t *testing.T) {
		if _, err := manager.handle(ctx, "restart", id, ""); err != nil {
			t.Fatal(err)
		}
		if err := manager.waitForReady(ctx, record); err != nil {
			t.Fatal(err)
		}
		client := s3(ro.accessKey, ro.secretKey, "us-east-1")
		if got := getObject(t, ctx, client, "alpha", "rw.txt"); got != "written by rw" {
			t.Fatalf("read-only key after restart read = %q", got)
		}
		raw, err := iam("iam_list_keys", managedStorageIAM{Principal: "gw-read-only"})
		if err != nil || !strings.Contains(raw, ro.accessKey) {
			t.Fatalf("list after restart = %s %v", raw, err)
		}
	})

	t.Run("repair recreates a lost container from staged secrets", func(t *testing.T) {
		previous := record.ContainerID
		if err := client.RemoveContainer(ctx, record.ContainerID, true); err != nil {
			t.Fatal(err)
		}
		repair := input
		if _, err := manager.handle(ctx, "create", id, encodeManagedStorageCommand(t, repair)); err != nil {
			t.Fatalf("repair create: %v", err)
		}
		record, _ = manager.loadRecord(id)
		if record.ContainerID == previous {
			t.Fatal("repair did not replace the container")
		}
		if got := getObject(t, ctx, s3(ro.accessKey, ro.secretKey, "us-east-1"), "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read after repair = %q", got)
		}
	})

	t.Run("publication change recreates and keeps data", func(t *testing.T) {
		port := freeTCPPort(t)
		update := managedStorageCommand{Version: 2, Engine: managedStorageEngineSeaweedFS, OperationID: "66666666-6666-4666-8666-666666666666", PublishS3: true, PublishedPort: port,
			Resources: managedStorageResources{NanoCPUs: input.Resources.NanoCPUs, MemoryBytes: input.Resources.MemoryBytes, MemorySwapBytes: input.Resources.MemorySwapBytes, StorageBytes: input.Resources.StorageBytes}}
		previous := record.ContainerID
		detail, err := manager.handle(ctx, "update", id, encodeManagedStorageCommand(t, update))
		if err != nil {
			t.Fatalf("publish: %v", err)
		}
		record, _ = manager.loadRecord(id)
		if record.ContainerID == previous || !record.PublishS3 || record.PublishedPort != port || !strings.Contains(detail, `"status":"ready"`) {
			t.Fatalf("publish detail %s record %#v", detail, record)
		}
		published := &http.Client{Transport: transport, Timeout: 5 * time.Second}
		response, err := published.Get("https://127.0.0.1:" + strconv.Itoa(int(port)) + "/healthz")
		if err != nil {
			// The certificate names storage.gateway.test/localhost/127.0.0.1.
			t.Fatalf("published S3 unreachable: %v", err)
		}
		response.Body.Close()
		networkInspect, err := client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
		if err != nil || networkInspect.Network.Internal {
			t.Fatalf("published storage network internal=%v err=%v", networkInspect.Network.Internal, err)
		}
		if got := getObject(t, ctx, s3(ro.accessKey, ro.secretKey, "us-east-1"), "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read after publish = %q", got)
		}
		update.PublishS3, update.PublishedPort = false, 0
		if _, err := manager.handle(ctx, "update", id, encodeManagedStorageCommand(t, update)); err != nil {
			t.Fatalf("unpublish: %v", err)
		}
		record, _ = manager.loadRecord(id)
		if _, err := published.Get("https://127.0.0.1:" + strconv.Itoa(int(port)) + "/healthz"); err == nil {
			t.Fatal("unpublished S3 still reachable on the host port")
		}
		networkInspect, err = client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
		if err != nil || !networkInspect.Network.Internal {
			t.Fatalf("private storage network internal=%v err=%v", networkInspect.Network.Internal, err)
		}
		if got := getObject(t, ctx, s3(ro.accessKey, ro.secretKey, "us-east-1"), "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read after unpublish = %q", got)
		}
	})

	t.Run("disk full, then grow", func(t *testing.T) {
		if err := admin.MakeBucket(ctx, "fill", minio.MakeBucketOptions{}); err != nil {
			t.Fatal(err)
		}
		chunk := make([]byte, 15*1024*1024)
		var failure error
		written := 0
		for index := 0; index < 120 && failure == nil; index++ {
			if _, err := rand.Read(chunk); err != nil {
				t.Fatal(err)
			}
			_, failure = admin.PutObject(ctx, "fill", fmt.Sprintf("chunk-%03d", index), bytes.NewReader(chunk), int64(len(chunk)), minio.PutObjectOptions{})
			if failure == nil {
				written++
			}
		}
		if failure == nil {
			t.Fatal("a 1 GiB disk accepted 1.8 GiB")
		}
		response := minio.ToErrorResponse(failure)
		t.Logf("disk full after %d x 15 MiB: HTTP %d %s (%s)", written, response.StatusCode, response.Code, response.Message)
		if response.StatusCode != http.StatusInternalServerError && response.StatusCode != http.StatusInsufficientStorage {
			t.Fatalf("disk-full write error = %#v", response)
		}
		usage, _ := manager.runtimeExec(ctx, record, "df -k /data | tail -1")
		t.Logf("data volume at failure: %s", strings.TrimSpace(usage))
		if err := manager.checkReady(ctx, record); err != nil {
			t.Fatalf("storage unhealthy when full: %v", err)
		}
		if got := getObject(t, ctx, admin, "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read when full = %q", got)
		}
		grow := managedStorageCommand{Version: 2, Engine: managedStorageEngineSeaweedFS, OperationID: "77777777-7777-4777-8777-777777777777",
			Resources: managedStorageResources{StorageBytes: 2 * minimumStorageBytes}}
		previous := record.ContainerID
		if _, err := manager.handle(ctx, "update", id, encodeManagedStorageCommand(t, grow)); err != nil {
			t.Fatalf("grow: %v", err)
		}
		record, _ = manager.loadRecord(id)
		inspect, err := client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
		if err != nil || record.ContainerID == previous || !slices.Contains(inspect.Container.Config.Cmd, "-volume.max=320") {
			t.Fatalf("grow did not recreate with resized flags: %v %v", inspect.Container.Config.Cmd, err)
		}
		waitFor(t, 3*time.Minute, "write after grow", func() error {
			_, err := admin.PutObject(ctx, "fill", "after-grow", bytes.NewReader(chunk), int64(len(chunk)), minio.PutObjectOptions{})
			return err
		})
		if got := getObject(t, ctx, s3(ro.accessKey, ro.secretKey, "us-east-1"), "alpha", "shared.txt"); got != "alpha data" {
			t.Fatalf("read after grow = %q", got)
		}
	})

	t.Run("delete_data removes staged secrets", func(t *testing.T) {
		staging := manager.seaweedfsStagingDir(record)
		if _, err := os.Stat(filepath.Join(staging, "config", "s3.json")); err != nil {
			t.Fatalf("staged identities missing before delete: %v", err)
		}
		if _, err := manager.handle(ctx, "delete_data", id, ""); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{staging, record.ImagePath} {
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s survived delete_data: %v", path, err)
			}
		}
		if mounted(record.MountPath) {
			t.Fatal("storage still mounted after delete_data")
		}
	})
}

func (m *managedStorageManager) runtimeExec(ctx context.Context, record managedStorageRecord, command string) (string, error) {
	created, err := m.client.cli.ExecCreate(ctx, record.ContainerID, mobyclient.ExecCreateOptions{Cmd: []string{"sh", "-c", command}, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return "", err
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return "", err
	}
	defer attached.Close()
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, attached.Reader); err != nil {
		return "", err
	}
	return stdout.String() + stderr.String(), nil
}

func seaweedfsE2ECertificates(t *testing.T, serverName string) (string, string, string) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "gateway storage e2e ca"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafTemplate := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: serverName}, DNSNames: []string{serverName, "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(leafKey)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})),
		string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
}

func seaweedfsE2ETransport(t *testing.T, caPEM, serverName string) *http.Transport {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPEM)) {
		t.Fatal("invalid e2e CA")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: serverName}
	return transport
}

func putObject(t *testing.T, ctx context.Context, client *minio.Client, bucket, key string, content []byte) {
	t.Helper()
	if _, err := client.PutObject(ctx, bucket, key, bytes.NewReader(content), int64(len(content)), minio.PutObjectOptions{}); err != nil {
		t.Fatalf("put %s/%s: %v", bucket, key, err)
	}
}

func putError(ctx context.Context, client *minio.Client, bucket, key string) error {
	_, err := client.PutObject(ctx, bucket, key, bytes.NewReader([]byte("x")), 1, minio.PutObjectOptions{})
	return err
}

func readObject(ctx context.Context, client *minio.Client, bucket, key string) (string, error) {
	object, err := client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return "", err
	}
	defer object.Close()
	raw, err := io.ReadAll(object)
	return string(raw), err
}

func getObject(t *testing.T, ctx context.Context, client *minio.Client, bucket, key string) string {
	t.Helper()
	value, err := readObject(ctx, client, bucket, key)
	if err != nil {
		t.Fatalf("get %s/%s: %v", bucket, key, err)
	}
	return value
}

func listError(ctx context.Context, client *minio.Client, bucket string) error {
	for object := range client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Recursive: true}) {
		if object.Err != nil {
			return object.Err
		}
	}
	return nil
}

func countObjects(ctx context.Context, client *minio.Client, bucket string) int {
	count := 0
	for object := range client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Recursive: true}) {
		if object.Err == nil {
			count++
		}
	}
	return count
}

func expectDenied(t *testing.T, name string, operation func() error) {
	t.Helper()
	err := operation()
	if code := minio.ToErrorResponse(err).Code; code != "AccessDenied" {
		t.Fatalf("%s: want AccessDenied, got %v", name, err)
	}
}

func waitFor(t *testing.T, timeout time.Duration, name string, condition func() error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		err := condition()
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: %v", name, err)
		}
		time.Sleep(time.Second)
	}
}

func freeTCPPort(t *testing.T) uint16 {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return uint16(listener.Addr().(*net.TCPAddr).Port)
}
