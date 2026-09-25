package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
)

type testTLSMaterial struct {
	CAPEM, CertPEM, KeyPEM string
	Fingerprint            string
	Pair                   tls.Certificate
}

// newTestTLSMaterial issues a CA and a server leaf naming localhost/127.0.0.1.
func newTestTLSMaterial(t *testing.T) testTLSMaterial {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano() + 1), Subject: pkix.Name{CommonName: "leaf"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(12 * time.Hour),
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	material := testTLSMaterial{
		CAPEM:   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})),
		CertPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})),
		KeyPEM:  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})),
	}
	leaf, err := leafCertificateFingerprint(material.CertPEM, material.KeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	material.Fingerprint = leaf.FingerprintSHA256
	material.Pair, err = tls.X509KeyPair([]byte(material.CertPEM), []byte(material.KeyPEM))
	if err != nil {
		t.Fatal(err)
	}
	return material
}

func fileInode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return uint64(info.Sys().(*syscall.Stat_t).Ino)
}

func TestWriteFileAtomicallyReplacesInsteadOfTruncating(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "key.pem")
	if err := writeFileAtomically(path, []byte("first"), 0600, nil); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	before := fileInode(t, path)
	var chowned []string
	if err := writeFileAtomically(path, []byte("second"), 0640, func(name string) error {
		chowned = append(chowned, name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// A reader of the previous file keeps its complete content: it was
	// replaced by a rename, never truncated in place.
	previous, err := io.ReadAll(reader)
	if err != nil || string(previous) != "first" {
		t.Fatalf("previous reader saw %q, err=%v", previous, err)
	}
	if fileInode(t, path) == before {
		t.Fatal("file was rewritten in place instead of renamed over")
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != "second" {
		t.Fatalf("current = %q, err=%v", current, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0640 {
		t.Fatalf("mode = %v", info.Mode())
	}
	if len(chowned) != 1 || filepath.Dir(chowned[0]) != directory || chowned[0] == path {
		t.Fatalf("chown must apply to the temporary file before the rename, got %v", chowned)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	failing := writeFileAtomically(path, []byte("third"), 0600, func(string) error { return errors.New("denied") })
	if failing == nil {
		t.Fatal("expected the chown failure to be returned")
	}
	if current, _ := os.ReadFile(path); string(current) != "second" {
		t.Fatalf("a failed write replaced the file: %q", current)
	}
	if entries, _ := os.ReadDir(directory); len(entries) != 1 {
		t.Fatalf("temporary files left behind after failure: %v", entries)
	}
}

func TestStageManagedStorageTLSRenamesOverPreviousMaterial(t *testing.T) {
	manager := &managedStorageManager{root: t.TempDir()}
	record := managedStorageRecord{ID: "11111111-1111-4111-8111-111111111111"}
	directory, err := manager.stageTLS(record, managedStorageTLS{CertPEM: "cert-1", KeyPEM: "key-1", CAPEM: "ca-1", ServerName: "a"})
	if err != nil {
		t.Fatal(err)
	}
	before := fileInode(t, filepath.Join(directory, "private.key"))
	if _, err := manager.stageTLS(record, managedStorageTLS{CertPEM: "cert-2", KeyPEM: "key-2", CAPEM: "ca-2", ServerName: "a"}); err != nil {
		t.Fatal(err)
	}
	if fileInode(t, filepath.Join(directory, "private.key")) == before {
		t.Fatal("MinIO key was truncated in place")
	}
	for name, want := range map[string]string{"public.crt": "cert-2", "private.key": "key-2", "CAs/gateway-ca.crt": "ca-2"} {
		if got, _ := os.ReadFile(filepath.Join(directory, name)); string(got) != want {
			t.Fatalf("%s = %q", name, got)
		}
	}
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestWriteManagedDatabaseTLSOwnsOnlyTheKey(t *testing.T) {
	previous := managedDatabaseChown
	owned := map[string][2]int{}
	managedDatabaseChown = func(path string, uid, gid int) error {
		owned[filepath.Base(path)] = [2]int{uid, gid}
		return nil
	}
	t.Cleanup(func() { managedDatabaseChown = previous })
	directory := filepath.Join(t.TempDir(), "tls")
	input := managedDatabaseCommand{Type: "postgres", TLSCertificatePEM: "cert", TLSPrivateKeyPEM: "key", TLSCACertificatePEM: "ca"}
	if err := writeManagedDatabaseTLS(directory, input); err != nil {
		t.Fatal(err)
	}
	before := fileInode(t, filepath.Join(directory, "key.pem"))
	input.TLSPrivateKeyPEM = "key-2"
	if err := writeManagedDatabaseTLS(directory, input); err != nil {
		t.Fatal(err)
	}
	if fileInode(t, filepath.Join(directory, "key.pem")) == before {
		t.Fatal("database key was truncated in place")
	}
	if info, _ := os.Stat(filepath.Join(directory, "key.pem")); info.Mode().Perm() != 0600 {
		t.Fatalf("key mode = %v", info.Mode())
	}
	if info, _ := os.Stat(filepath.Join(directory, "cert.pem")); info.Mode().Perm() != 0644 {
		t.Fatalf("cert mode = %v", info.Mode())
	}
	if owned["tls"] != [2]int{999, 999} {
		t.Fatalf("TLS directory owner = %v", owned["tls"])
	}
	keyOwned := false
	for name, owner := range owned {
		if strings.HasPrefix(name, ".key.pem.tmp-") && owner == [2]int{999, 999} {
			keyOwned = true
		}
		if strings.HasPrefix(name, ".cert.pem") || strings.HasPrefix(name, ".ca.pem") {
			t.Fatalf("public material must stay daemon-owned: %s", name)
		}
	}
	if !keyOwned {
		t.Fatalf("key was not handed to the engine account before the rename: %v", owned)
	}
}

func TestRunTLSReload(t *testing.T) {
	previousWait := managedTLSReloadWait
	managedTLSReloadWait = 50 * time.Millisecond
	t.Cleanup(func() { managedTLSReloadWait = previousWait })
	const expected = "new"
	served := func(fingerprints ...string) func(context.Context) (servedCertificate, error) {
		var mu sync.Mutex
		index := 0
		return func(context.Context) (servedCertificate, error) {
			mu.Lock()
			defer mu.Unlock()
			value := fingerprints[min(index, len(fingerprints)-1)]
			index++
			return servedCertificate{FingerprintSHA256: value}, nil
		}
	}
	t.Run("served after trigger", func(t *testing.T) {
		staged, triggered := false, false
		result, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Method: tlsReloadMethodSignal,
			Stage:   func() error { staged = true; return nil },
			Trigger: func(context.Context) error { triggered = true; return nil },
			Probe:   served("old", expected), Wait: 2 * time.Second,
		})
		if err != nil || !staged || !triggered {
			t.Fatalf("err=%v staged=%v triggered=%v", err, staged, triggered)
		}
		if result.Status != tlsReloadStatusReloaded || result.Restarted || result.FingerprintSHA256 != expected || result.Method != tlsReloadMethodSignal {
			t.Fatalf("result = %+v", result)
		}
	})
	t.Run("pending without restart", func(t *testing.T) {
		restarted := false
		result, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Method: tlsReloadMethodFileWatch, ReloadInterval: 5 * time.Hour,
			Probe: served("old"), Wait: 10 * time.Millisecond,
			Restart: func(context.Context) error { restarted = true; return nil },
		})
		if err != nil || restarted {
			t.Fatalf("err=%v restarted=%v", err, restarted)
		}
		if result.Status != tlsReloadStatusPending || result.FingerprintSHA256 != "old" || result.ReloadIntervalSeconds != 18000 {
			t.Fatalf("result = %+v", result)
		}
	})
	t.Run("restart fallback", func(t *testing.T) {
		restarted := false
		probe := func(context.Context) (servedCertificate, error) {
			if restarted {
				return servedCertificate{FingerprintSHA256: expected}, nil
			}
			return servedCertificate{FingerprintSHA256: "old"}, nil
		}
		result, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Method: tlsReloadMethodFileWatch, Probe: probe, Wait: 10 * time.Millisecond,
			AllowRestart: true, Restart: func(context.Context) error { restarted = true; return nil },
		})
		if err != nil || result.Status != tlsReloadStatusReloaded || !result.Restarted || result.Method != tlsReloadMethodRestart {
			t.Fatalf("result = %+v err=%v", result, err)
		}
	})
	t.Run("trigger failure without restart", func(t *testing.T) {
		_, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Trigger: func(context.Context) error { return errors.New("exec failed") },
			Probe: served("old"), Wait: time.Millisecond,
		})
		if err == nil || !strings.Contains(err.Error(), "exec failed") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("restart still serving old certificate", func(t *testing.T) {
		_, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Probe: served("old"), Wait: time.Millisecond,
			AllowRestart: true, Restart: func(context.Context) error { return nil },
		})
		if err == nil || !strings.Contains(err.Error(), "expected new") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("stage failure stops before the engine", func(t *testing.T) {
		triggered := false
		_, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected, Stage: func() error { return errors.New("disk full") },
			Trigger: func(context.Context) error { triggered = true; return nil }, Probe: served(expected),
		})
		if err == nil || triggered {
			t.Fatalf("err=%v triggered=%v", err, triggered)
		}
	})
	t.Run("unreachable listener", func(t *testing.T) {
		_, err := runTLSReload(context.Background(), tlsReloadPlan{
			Expected: expected,
			Probe:    func(context.Context) (servedCertificate, error) { return servedCertificate{}, errors.New("refused") },
			Wait:     time.Millisecond,
		})
		if err == nil || !strings.Contains(err.Error(), "refused") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestProbeServedCertificateDirectAndPostgres(t *testing.T) {
	material := newTestTLSMaterial(t)
	config := &tls.Config{Certificates: []tls.Certificate{material.Pair}, MinVersion: tls.VersionTLS12}
	direct, err := tls.Listen("tcp", "127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	defer direct.Close()
	go func() {
		for {
			conn, err := direct.Accept()
			if err != nil {
				return
			}
			_ = conn.(*tls.Conn).Handshake()
			_ = conn.Close()
		}
	}()
	served, err := probeServedCertificate(context.Background(), direct.Addr().String(), managedTLSProtocolDirect)
	if err != nil || served.FingerprintSHA256 != material.Fingerprint {
		t.Fatalf("direct probe = %+v err=%v", served, err)
	}
	if len(served.DNSNames) != 1 || served.DNSNames[0] != "localhost" || len(served.IPAddresses) != 1 || served.IPAddresses[0] != "127.0.0.1" {
		t.Fatalf("names = %v %v", served.DNSNames, served.IPAddresses)
	}

	postgres, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer postgres.Close()
	go func() {
		for {
			conn, err := postgres.Accept()
			if err != nil {
				return
			}
			request := make([]byte, 8)
			if _, err := io.ReadFull(conn, request); err != nil || binary.BigEndian.Uint32(request[4:]) != postgresSSLRequestCode {
				_ = conn.Close()
				continue
			}
			_, _ = conn.Write([]byte("S"))
			server := tls.Server(conn, config)
			_ = server.Handshake()
			_ = server.Close()
		}
	}()
	served, err = probeServedCertificate(context.Background(), postgres.Addr().String(), managedTLSProtocolPostgres)
	if err != nil || served.FingerprintSHA256 != material.Fingerprint {
		t.Fatalf("postgres probe = %+v err=%v", served, err)
	}
}

func TestParseManagedTLSReloadCommands(t *testing.T) {
	material := newTestTLSMaterial(t)
	other := newTestTLSMaterial(t)
	storage := func(mutate func(*managedStorageTLSReloadCommand)) string {
		input := managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: material.CertPEM, KeyPEM: material.KeyPEM, CAPEM: material.CAPEM, ServerName: "10.0.0.5"}}
		mutate(&input)
		raw, _ := json.Marshal(input)
		return string(raw)
	}
	if _, leaf, err := parseManagedStorageTLSReloadCommand(storage(func(*managedStorageTLSReloadCommand) {})); err != nil || leaf.FingerprintSHA256 != material.Fingerprint {
		t.Fatalf("valid storage reload rejected: %v", err)
	}
	for name, mutate := range map[string]func(*managedStorageTLSReloadCommand){
		"version":     func(c *managedStorageTLSReloadCommand) { c.Version = 2 },
		"server name": func(c *managedStorageTLSReloadCommand) { c.TLS.ServerName = "" },
		"foreign key": func(c *managedStorageTLSReloadCommand) { c.TLS.KeyPEM = other.KeyPEM },
		"no ca":       func(c *managedStorageTLSReloadCommand) { c.TLS.CAPEM = "" },
	} {
		if _, _, err := parseManagedStorageTLSReloadCommand(storage(mutate)); err == nil {
			t.Fatalf("storage reload with invalid %s accepted", name)
		}
	}

	database := func(mutate func(*managedDatabaseTLSReloadCommand)) string {
		input := managedDatabaseTLSReloadCommand{
			Type: "redis", OwnerUsername: "default", OwnerPassword: "a-long-random-secret-password", DatabaseName: "redis",
			TLSCertificatePEM: material.CertPEM, TLSPrivateKeyPEM: material.KeyPEM, TLSCACertificatePEM: material.CAPEM,
			TLSCertificateID: "0f7e4d4c-3c52-4c61-9a41-1d8e0c4d2a10",
		}
		mutate(&input)
		raw, _ := json.Marshal(input)
		return string(raw)
	}
	if _, leaf, err := parseManagedDatabaseTLSReloadCommand(database(func(*managedDatabaseTLSReloadCommand) {})); err != nil || leaf.FingerprintSHA256 != material.Fingerprint {
		t.Fatalf("valid database reload rejected: %v", err)
	}
	for name, mutate := range map[string]func(*managedDatabaseTLSReloadCommand){
		"engine":         func(c *managedDatabaseTLSReloadCommand) { c.Type = "mysql" },
		"redis owner":    func(c *managedDatabaseTLSReloadCommand) { c.OwnerUsername = "owner" },
		"certificate id": func(c *managedDatabaseTLSReloadCommand) { c.TLSCertificateID = "../x" },
		"short password": func(c *managedDatabaseTLSReloadCommand) { c.OwnerPassword = "short" },
		"foreign key":    func(c *managedDatabaseTLSReloadCommand) { c.TLSPrivateKeyPEM = other.KeyPEM },
	} {
		if _, _, err := parseManagedDatabaseTLSReloadCommand(database(mutate)); err == nil {
			t.Fatalf("database reload with invalid %s accepted", name)
		}
	}
}

func TestManagedDatabaseCertificateChangeDoesNotRecreate(t *testing.T) {
	input := validManagedDatabaseInput()
	input.TLSEnabled = true
	input.TLSCertificateID = "certificate_new"
	record := managedDatabaseRecord{Type: "postgres", TLSEnabled: true, TLSCertificateID: "certificate_old"}
	if managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("a renewed certificate must be reloaded, not recreate the container")
	}
	input.TLSEnabled = false
	if !managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("turning TLS off still changes the listener ports and must recreate")
	}
}

// fakeTLSContainerEngine answers the Docker calls reloadTLS makes: inspect of
// one owned running container, and kill/stop/start/restart, which it records.
type fakeTLSContainerEngine struct {
	mu      sync.Mutex
	labels  map[string]string
	env     []string
	network string
	calls   []string
}

func (e *fakeTLSContainerEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/containers/storage-container/json"):
		labels, _ := json.Marshal(e.labels)
		env, _ := json.Marshal(e.env)
		_, _ = w.Write([]byte(`{"Id":"storage-container","State":{"Running":true,"Status":"running","Health":{"Status":"healthy"}},` +
			`"Config":{"Labels":` + string(labels) + `,"Env":` + string(env) + `},` +
			`"NetworkSettings":{"Networks":{"` + e.network + `":{"IPAddress":"172.30.0.2"}}}}`))
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/kill"):
		e.calls = append(e.calls, "kill:"+r.URL.Query().Get("signal"))
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && (strings.HasSuffix(path, "/stop") || strings.HasSuffix(path, "/start") || strings.HasSuffix(path, "/restart")):
		e.calls = append(e.calls, path[strings.LastIndex(path, "/")+1:])
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"unexpected ` + r.Method + ` ` + path + `"}`))
	}
}

func TestManagedStorageReloadTLSSignalsMinIOAndVerifiesServedCertificate(t *testing.T) {
	material := newTestTLSMaterial(t)
	id := "11111111-1111-4111-8111-111111111111"
	engine := &fakeTLSContainerEngine{labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0"}, network: "gateway-storage-" + id}
	var probed []string
	manager := &managedStorageManager{root: t.TempDir(), client: newFakeImageClient(t, engine)}
	manager.probeServed = func(_ context.Context, address, protocol string) (servedCertificate, error) {
		engine.mu.Lock()
		signalled := len(engine.calls) > 0
		engine.mu.Unlock()
		probed = append(probed, address+"/"+protocol)
		if signalled {
			return servedCertificate{FingerprintSHA256: material.Fingerprint}, nil
		}
		return servedCertificate{FingerprintSHA256: "previous"}, nil
	}
	for _, dir := range []string{"storage/records"} {
		if err := os.MkdirAll(filepath.Join(manager.root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	record := managedStorageRecord{ID: id, ContainerID: "storage-container", NetworkName: "gateway-storage-" + id, TLSEnabled: true, TLSServerName: "old.example", DesiredRunning: true}
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: material.CertPEM, KeyPEM: material.KeyPEM, CAPEM: material.CAPEM, ServerName: "10.0.0.5"}})
	detail, err := manager.handle(context.Background(), "reload_tls", id, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	var result tlsReloadResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != tlsReloadStatusReloaded || result.Restarted || result.Method != tlsReloadMethodSignal || result.FingerprintSHA256 != material.Fingerprint {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.calls) != 1 || engine.calls[0] != "kill:SIGHUP" {
		t.Fatalf("docker calls = %v (MinIO must be signalled, not restarted)", engine.calls)
	}
	if len(probed) == 0 || probed[0] != "172.30.0.2:9000/tls" {
		t.Fatalf("probed = %v", probed)
	}
	staged, _ := os.ReadFile(filepath.Join(manager.root, "storage", "tls", id+"-0", "public.crt"))
	if string(staged) != material.CertPEM {
		t.Fatal("renewed certificate was not staged")
	}
	saved, _ := manager.loadRecord(id)
	if saved.TLSServerName != "10.0.0.5" {
		t.Fatalf("server name = %q", saved.TLSServerName)
	}
}

func TestManagedStorageReloadTLSSeaweedFSReportsPendingUntilReread(t *testing.T) {
	material := newTestTLSMaterial(t)
	id := "22222222-2222-4222-8222-222222222222"
	engine := &fakeTLSContainerEngine{labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0"}, network: "gateway-storage-" + id, env: []string{"GOMEMLIMIT=435MiB"}}
	manager := &managedStorageManager{root: t.TempDir(), client: newFakeImageClient(t, engine), chown: func(string, int, int) error { return nil }}
	manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
		return servedCertificate{FingerprintSHA256: "previous"}, nil
	}
	if err := os.MkdirAll(filepath.Join(manager.root, "storage", "records"), 0700); err != nil {
		t.Fatal(err)
	}
	record := managedStorageRecord{ID: id, Engine: managedStorageEngineSeaweedFS, ContainerID: "storage-container", NetworkName: "gateway-storage-" + id, TLSEnabled: true, TLSServerName: "10.0.0.5", DesiredRunning: true}
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.removeSeaweedFSStaging(record) })
	raw, _ := json.Marshal(managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: material.CertPEM, KeyPEM: material.KeyPEM, CAPEM: material.CAPEM, ServerName: "10.0.0.5"}})
	started := time.Now()
	detail, err := manager.handle(context.Background(), "reload_tls", id, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 10*time.Second {
		t.Fatal("a five-hour refresh interval must not be waited for")
	}
	var result tlsReloadResult
	_ = json.Unmarshal([]byte(detail), &result)
	if result.Status != tlsReloadStatusPending || result.Method != tlsReloadMethodFileWatch || result.ReloadIntervalSeconds != 5*60*60 || result.Restarted {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.calls) != 0 {
		t.Fatalf("SeaweedFS must reread its files, not be signalled or restarted: %v", engine.calls)
	}
	staged, _ := os.ReadFile(filepath.Join(manager.seaweedfsStagingDir(record), "tls", "public.crt"))
	if string(staged) != material.CertPEM {
		t.Fatal("renewed certificate was not staged")
	}

	// A container created with the short refresh interval is waited for.
	engine.env = append(engine.env, "WEED_TLS_CERT_REFRESH_INTERVAL=1m")
	if got := seaweedfsContainerTLSRefreshInterval(&container.Config{Env: engine.env}); got != time.Minute {
		t.Fatalf("interval = %v", got)
	}
	manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
		return servedCertificate{FingerprintSHA256: material.Fingerprint}, nil
	}
	detail, err = manager.handle(context.Background(), "reload_tls", id, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(detail), &result)
	if result.Status != tlsReloadStatusReloaded || result.ReloadIntervalSeconds != 60 || result.Restarted {
		t.Fatalf("result = %+v", result)
	}
}

func TestSeaweedFSContainerTLSRefreshInterval(t *testing.T) {
	if got := seaweedfsContainerTLSRefreshInterval(nil); got != 5*time.Hour {
		t.Fatalf("nil config = %v", got)
	}
}

func TestManagedDatabaseReloadTLSRecordsCertificateOnlyWhenServed(t *testing.T) {
	previousWait := managedTLSReloadWait
	managedTLSReloadWait = 50 * time.Millisecond
	t.Cleanup(func() { managedTLSReloadWait = previousWait })
	previous := managedDatabaseChown
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = previous })
	material := newTestTLSMaterial(t)
	id := "database_1"
	engine := &fakeTLSContainerEngine{labels: map[string]string{managedDatabaseLabel: id}, network: "gwdb-" + id + "-net"}
	root := t.TempDir()
	manager := &managedDatabaseManager{root: root, client: newFakeImageClient(t, engine)}
	for _, dir := range []string{"records", "tls"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	serveNew := false
	var probedAddress string
	manager.probeServed = func(_ context.Context, address, protocol string) (servedCertificate, error) {
		probedAddress = address + "/" + protocol
		if serveNew {
			return servedCertificate{FingerprintSHA256: material.Fingerprint}, nil
		}
		return servedCertificate{FingerprintSHA256: "previous"}, nil
	}
	record := managedDatabaseRecord{
		ID: id, Type: "postgres", ContainerID: "storage-container", NetworkName: "gwdb-" + id + "-net",
		ImagePath: filepath.Join(root, "images", id+".img"), MountPath: filepath.Join(root, "mounts", id),
		TLSEnabled: true, TLSCertificateID: "certificate_old", DesiredRunning: true,
	}
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	payload := func(allowRestart bool) string {
		raw, _ := json.Marshal(managedDatabaseTLSReloadCommand{
			Type: "postgres", OwnerUsername: "app_owner", OwnerPassword: "a-long-random-secret-password", DatabaseName: "app",
			TLSCertificatePEM: material.CertPEM, TLSPrivateKeyPEM: material.KeyPEM, TLSCACertificatePEM: material.CAPEM,
			TLSCertificateID: "certificate_new", AllowRestart: allowRestart,
		})
		return string(raw)
	}
	detail, err := manager.handle(context.Background(), "reload_tls", id, payload(false))
	if err != nil {
		t.Fatal(err)
	}
	var result tlsReloadResult
	_ = json.Unmarshal([]byte(detail), &result)
	if result.Status != tlsReloadStatusPending || result.Method != tlsReloadMethodSignal {
		t.Fatalf("result = %+v", result)
	}
	if saved, _ := manager.loadRecord(id); saved.TLSCertificateID != "certificate_old" {
		t.Fatalf("an unserved certificate was recorded: %q", saved.TLSCertificateID)
	}
	if engine.calls[0] != "kill:SIGHUP" || probedAddress != "172.30.0.2:5432/postgres" {
		t.Fatalf("calls=%v probe=%s", engine.calls, probedAddress)
	}
	if staged, _ := os.ReadFile(filepath.Join(root, "tls", id, "cert.pem")); string(staged) != material.CertPEM {
		t.Fatal("renewed certificate was not staged")
	}

	serveNew = true
	detail, err = manager.handle(context.Background(), "reload_tls", id, payload(false))
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(detail), &result)
	if result.Status != tlsReloadStatusReloaded || result.Restarted {
		t.Fatalf("result = %+v", result)
	}
	if saved, _ := manager.loadRecord(id); saved.TLSCertificateID != "certificate_new" {
		t.Fatalf("served certificate was not recorded: %q", saved.TLSCertificateID)
	}
}

// The daemon's relay dial takes the manager lock; a reload must not hold it
// while the engine takes its time.
func TestTLSReloadWaitsWithoutTheManagerLock(t *testing.T) {
	previousWait := managedTLSReloadWait
	managedTLSReloadWait = 50 * time.Millisecond
	t.Cleanup(func() { managedTLSReloadWait = previousWait })
	material := newTestTLSMaterial(t)

	t.Run("storage", func(t *testing.T) {
		id := "33333333-3333-4333-8333-333333333333"
		engine := &fakeTLSContainerEngine{labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0"}, network: "gateway-storage-" + id}
		manager := &managedStorageManager{root: t.TempDir(), client: newFakeImageClient(t, engine)}
		if err := os.MkdirAll(filepath.Join(manager.root, "storage", "records"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := manager.saveRecord(managedStorageRecord{ID: id, ContainerID: "storage-container", NetworkName: "gateway-storage-" + id, TLSEnabled: true, DesiredRunning: true}); err != nil {
			t.Fatal(err)
		}
		lockFree := true
		manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
			if manager.mu.TryLock() {
				manager.mu.Unlock()
			} else {
				lockFree = false
			}
			return servedCertificate{FingerprintSHA256: "previous"}, nil
		}
		raw, _ := json.Marshal(managedStorageTLSReloadCommand{Version: 1, TLS: managedStorageTLS{CertPEM: material.CertPEM, KeyPEM: material.KeyPEM, CAPEM: material.CAPEM, ServerName: "10.0.0.5"}})
		detail, err := manager.handle(context.Background(), "reload_tls", id, string(raw))
		if err != nil {
			t.Fatal(err)
		}
		if !lockFree {
			t.Fatal("the storage manager lock was held while waiting for the engine")
		}
		if !strings.Contains(detail, `"status":"pending"`) {
			t.Fatalf("detail = %s", detail)
		}
		if _, err := manager.handle(context.Background(), "probe_tls", id, ""); err != nil {
			t.Fatal(err)
		}
		if !lockFree {
			t.Fatal("the storage manager lock was held while probing")
		}
	})

	t.Run("database", func(t *testing.T) {
		previous := managedDatabaseChown
		managedDatabaseChown = func(string, int, int) error { return nil }
		t.Cleanup(func() { managedDatabaseChown = previous })
		manager, id := newTLSDatabaseManager(t)
		lockFree := true
		manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
			if manager.mu.TryLock() {
				manager.mu.Unlock()
			} else {
				lockFree = false
			}
			return servedCertificate{FingerprintSHA256: material.Fingerprint}, nil
		}
		detail, err := manager.handle(context.Background(), "reload_tls", id, tlsDatabasePayload(material, false))
		if err != nil {
			t.Fatal(err)
		}
		if !lockFree || !strings.Contains(detail, `"status":"reloaded"`) {
			t.Fatalf("lockFree=%v detail=%s", lockFree, detail)
		}
		if saved, _ := manager.loadRecord(id); saved.TLSCertificateID != "certificate_new" {
			t.Fatalf("certificate id = %q", saved.TLSCertificateID)
		}
	})
}

// A lifecycle operation that ran while the reload waited wins: the reload
// neither records its certificate id nor restarts the recreated database.
func TestTLSReloadYieldsToConcurrentLifecycleChanges(t *testing.T) {
	previousWait := managedTLSReloadWait
	managedTLSReloadWait = 50 * time.Millisecond
	t.Cleanup(func() { managedTLSReloadWait = previousWait })
	previous := managedDatabaseChown
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = previous })
	material := newTestTLSMaterial(t)

	manager, id := newTLSDatabaseManager(t)
	manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
		// An update of the same database lands while the reload waits.
		manager.mu.Lock()
		manager.generations.bump(id)
		manager.mu.Unlock()
		return servedCertificate{FingerprintSHA256: material.Fingerprint}, nil
	}
	if _, err := manager.handle(context.Background(), "reload_tls", id, tlsDatabasePayload(material, false)); err != nil {
		t.Fatal(err)
	}
	if saved, _ := manager.loadRecord(id); saved.TLSCertificateID != "certificate_old" {
		t.Fatalf("a concurrent update was overwritten: certificate id = %q", saved.TLSCertificateID)
	}

	manager.probeServed = func(context.Context, string, string) (servedCertificate, error) {
		manager.mu.Lock()
		manager.generations.bump(id)
		manager.mu.Unlock()
		return servedCertificate{FingerprintSHA256: "previous"}, nil
	}
	_, err := manager.handle(context.Background(), "reload_tls", id, tlsDatabasePayload(material, true))
	if err == nil || !strings.Contains(err.Error(), "changed during the certificate reload") {
		t.Fatalf("restart after a concurrent change: err = %v", err)
	}
}

func newTLSDatabaseManager(t *testing.T) (*managedDatabaseManager, string) {
	t.Helper()
	id := "database_2"
	engine := &fakeTLSContainerEngine{labels: map[string]string{managedDatabaseLabel: id}, network: "gwdb-" + id + "-net"}
	root := t.TempDir()
	manager := &managedDatabaseManager{root: root, client: newFakeImageClient(t, engine)}
	for _, dir := range []string{"records", "tls"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	record := managedDatabaseRecord{
		ID: id, Type: "postgres", ContainerID: "storage-container", NetworkName: "gwdb-" + id + "-net",
		ImagePath: filepath.Join(root, "images", id+".img"), MountPath: filepath.Join(root, "mounts", id),
		TLSEnabled: true, TLSCertificateID: "certificate_old", DesiredRunning: true,
	}
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return manager, id
}

func tlsDatabasePayload(material testTLSMaterial, allowRestart bool) string {
	raw, _ := json.Marshal(managedDatabaseTLSReloadCommand{
		Type: "postgres", OwnerUsername: "app_owner", OwnerPassword: "a-long-random-secret-password", DatabaseName: "app",
		TLSCertificatePEM: material.CertPEM, TLSPrivateKeyPEM: material.KeyPEM, TLSCACertificatePEM: material.CAPEM,
		TLSCertificateID: "certificate_new", AllowRestart: allowRestart,
	})
	return string(raw)
}
