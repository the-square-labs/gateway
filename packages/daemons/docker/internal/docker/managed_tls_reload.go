package docker

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// managedTLSReloadCapability is reported by storage-profile daemons that
// accept the `reload_tls` and `probe_tls` actions on managed storage and
// managed database commands. The control plane renews certificates through
// them without recreating the workload.
const managedTLSReloadCapability = "managed_tls_reload_v1"

// seaweedfsTLSRefreshInterval is how often SeaweedFS rereads its S3 certificate
// files (WEED_TLS_CERT_REFRESH_INTERVAL; the upstream default is 5h). Containers
// created before rc.9 keep the default and pick a renewed certificate up within
// five hours; new and recreated containers within a minute.
const seaweedfsTLSRefreshInterval = "1m"

const (
	managedTLSProbeTimeout      = 5 * time.Second
	managedTLSProbeInterval     = 500 * time.Millisecond
	managedTLSMaximumReloadWait = 3 * time.Minute
	managedTLSProtocolDirect    = "tls"
	managedTLSProtocolPostgres  = "postgres"
	postgresSSLRequestCode      = 80877103
	tlsReloadStatusReloaded     = "reloaded"
	tlsReloadStatusPending      = "pending"
	tlsReloadMethodRestart      = "restart"
	tlsReloadMethodSignal       = "sighup"
	tlsReloadMethodFileWatch    = "file_watch"
	tlsReloadMethodConfigSet    = "config_set"
	tlsReloadMethodSystemReload = "system_reload_config"
)

// managedTLSReloadWait bounds how long a signalled engine may take to serve
// the staged certificate (a variable so tests need not wait for it).
var managedTLSReloadWait = 20 * time.Second

// servedCertificate identifies the leaf a TLS listener presents.
type servedCertificate struct {
	FingerprintSHA256 string    `json:"fingerprintSha256"`
	NotAfter          time.Time `json:"notAfter"`
	DNSNames          []string  `json:"dnsNames"`
	IPAddresses       []string  `json:"ipAddresses"`
}

// tlsReloadResult is the `reload_tls` command detail. `pending` means the
// material is staged but the engine still serves the previous certificate
// (it rereads it on its own schedule); the caller retries later with the same
// material, which is idempotent.
type tlsReloadResult struct {
	Status                    string    `json:"status"`
	FingerprintSHA256         string    `json:"fingerprintSha256"`
	ExpectedFingerprintSHA256 string    `json:"expectedFingerprintSha256"`
	NotAfter                  time.Time `json:"notAfter,omitempty"`
	Restarted                 bool      `json:"restarted"`
	Method                    string    `json:"method"`
	ReloadIntervalSeconds     int64     `json:"reloadIntervalSeconds,omitempty"`
}

// tlsReloadPlan is one engine's reload procedure. runTLSReload drives it so
// the decision logic (served, pending, restart fallback) is shared and tested
// independently of Docker.
type tlsReloadPlan struct {
	Expected     string
	Method       string
	Stage        func() error
	Trigger      func(ctx context.Context) error
	Probe        func(ctx context.Context) (servedCertificate, error)
	Wait         time.Duration
	AllowRestart bool
	Restart      func(ctx context.Context) error
	// ReloadInterval is reported to the caller when the engine rereads the
	// files itself (SeaweedFS), so it knows when to check again.
	ReloadInterval time.Duration
}

// runTLSReload runs the whole plan; the caller holds whatever lock the plan
// needs for its full duration (the update path, which already owns the
// resource). The reload command instead splits it into prepareTLSReload
// (under the manager lock) and awaitTLSReload (without it).
func runTLSReload(ctx context.Context, plan tlsReloadPlan) (tlsReloadResult, error) {
	triggerErr, err := prepareTLSReload(ctx, plan)
	if err != nil {
		return tlsReloadResult{ExpectedFingerprintSHA256: plan.Expected, Method: plan.Method}, err
	}
	return awaitTLSReload(ctx, plan, triggerErr)
}

// prepareTLSReload stages the material and asks the engine to reload it. A
// failed trigger is returned separately: with a restart allowed it is not
// fatal, since the restarted engine loads the staged files.
func prepareTLSReload(ctx context.Context, plan tlsReloadPlan) (triggerErr error, err error) {
	if plan.Stage != nil {
		if err := plan.Stage(); err != nil {
			return nil, err
		}
	}
	if plan.Trigger != nil {
		if err := plan.Trigger(ctx); err != nil {
			if !plan.AllowRestart || plan.Restart == nil {
				return nil, err
			}
			return err, nil
		}
	}
	return nil, nil
}

// awaitTLSReload waits for the engine to serve the staged certificate and
// falls back to a restart when allowed. It takes no lock itself.
func awaitTLSReload(ctx context.Context, plan tlsReloadPlan, triggerErr error) (tlsReloadResult, error) {
	result := tlsReloadResult{ExpectedFingerprintSHA256: plan.Expected, Method: plan.Method, ReloadIntervalSeconds: int64(plan.ReloadInterval / time.Second)}
	if triggerErr != nil {
		return restartForTLS(ctx, plan, result)
	}
	served, matched, err := waitForServedCertificate(ctx, plan.Probe, plan.Expected, plan.Wait)
	if matched {
		result.Status = tlsReloadStatusReloaded
		result.FingerprintSHA256 = served.FingerprintSHA256
		result.NotAfter = served.NotAfter
		return result, nil
	}
	if plan.AllowRestart && plan.Restart != nil {
		return restartForTLS(ctx, plan, result)
	}
	if err != nil && served.FingerprintSHA256 == "" {
		return result, fmt.Errorf("probe served certificate: %w", err)
	}
	result.Status = tlsReloadStatusPending
	result.FingerprintSHA256 = served.FingerprintSHA256
	result.NotAfter = served.NotAfter
	return result, nil
}

func restartForTLS(ctx context.Context, plan tlsReloadPlan, result tlsReloadResult) (tlsReloadResult, error) {
	if err := plan.Restart(ctx); err != nil {
		return result, fmt.Errorf("restart to load the renewed certificate: %w", err)
	}
	result.Restarted = true
	result.Method = tlsReloadMethodRestart
	served, matched, err := waitForServedCertificate(ctx, plan.Probe, plan.Expected, managedTLSReloadWait)
	result.FingerprintSHA256 = served.FingerprintSHA256
	result.NotAfter = served.NotAfter
	if !matched {
		if err != nil {
			return result, fmt.Errorf("probe served certificate after restart: %w", err)
		}
		return result, fmt.Errorf("the restarted engine serves certificate %s, expected %s", served.FingerprintSHA256, plan.Expected)
	}
	result.Status = tlsReloadStatusReloaded
	return result, nil
}

// waitForServedCertificate probes until the expected leaf is served or wait
// elapses. It always probes at least once and returns the last observation.
func waitForServedCertificate(ctx context.Context, probe func(context.Context) (servedCertificate, error), expected string, wait time.Duration) (servedCertificate, bool, error) {
	if probe == nil {
		return servedCertificate{}, false, errors.New("no certificate probe")
	}
	deadline := time.Now().Add(wait)
	var last servedCertificate
	var lastErr error
	for {
		probeCtx, cancel := context.WithTimeout(ctx, managedTLSProbeTimeout)
		served, err := probe(probeCtx)
		cancel()
		if err == nil {
			last, lastErr = served, nil
			if served.FingerprintSHA256 == expected {
				return served, true, nil
			}
		} else {
			lastErr = err
		}
		if !time.Now().Before(deadline) {
			return last, false, lastErr
		}
		timer := time.NewTimer(managedTLSProbeInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return last, false, ctx.Err()
		case <-timer.C:
		}
	}
}

// probeServedCertificate connects to a TLS listener and returns the leaf it
// serves. The chain is deliberately not verified: the caller compares the
// fingerprint with the certificate it just staged, which is a stronger check
// than chain validity (the previous leaf is signed by the same CA).
func probeServedCertificate(ctx context.Context, address, protocol string) (servedCertificate, error) {
	dialer := &net.Dialer{Timeout: managedTLSProbeTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return servedCertificate{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(managedTLSProbeTimeout))
	}
	if protocol == managedTLSProtocolPostgres {
		request := make([]byte, 8)
		binary.BigEndian.PutUint32(request[0:4], 8)
		binary.BigEndian.PutUint32(request[4:8], postgresSSLRequestCode)
		if _, err := conn.Write(request); err != nil {
			return servedCertificate{}, fmt.Errorf("send PostgreSQL SSLRequest: %w", err)
		}
		answer := make([]byte, 1)
		if _, err := io.ReadFull(conn, answer); err != nil {
			return servedCertificate{}, fmt.Errorf("read PostgreSQL SSLRequest answer: %w", err)
		}
		if answer[0] != 'S' {
			return servedCertificate{}, errors.New("PostgreSQL refused TLS")
		}
	}
	// #nosec G402 -- identity is established by comparing the leaf fingerprint.
	client := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	if err := client.HandshakeContext(ctx); err != nil {
		return servedCertificate{}, fmt.Errorf("TLS handshake: %w", err)
	}
	peers := client.ConnectionState().PeerCertificates
	if len(peers) == 0 {
		return servedCertificate{}, errors.New("TLS listener presented no certificate")
	}
	return describeCertificate(peers[0]), nil
}

func describeCertificate(certificate *x509.Certificate) servedCertificate {
	digest := sha256.Sum256(certificate.Raw)
	addresses := make([]string, 0, len(certificate.IPAddresses))
	for _, address := range certificate.IPAddresses {
		addresses = append(addresses, address.String())
	}
	return servedCertificate{
		FingerprintSHA256: hex.EncodeToString(digest[:]),
		NotAfter:          certificate.NotAfter.UTC(),
		DNSNames:          append([]string{}, certificate.DNSNames...),
		IPAddresses:       addresses,
	}
}

// leafCertificateFingerprint returns the SHA-256 of the first certificate in
// a PEM bundle and checks that the key belongs to it.
func leafCertificateFingerprint(certPEM, keyPEM string) (servedCertificate, error) {
	if _, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM)); err != nil {
		return servedCertificate{}, errors.New("TLS certificate and key do not form a valid pair")
	}
	block, _ := pem.Decode([]byte(certPEM))
	if block == nil || block.Type != "CERTIFICATE" {
		return servedCertificate{}, errors.New("TLS certificate PEM is invalid")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return servedCertificate{}, fmt.Errorf("parse TLS certificate: %w", err)
	}
	if time.Now().After(certificate.NotAfter) {
		return servedCertificate{}, errors.New("TLS certificate has expired")
	}
	return describeCertificate(certificate), nil
}

// resourceLocks serializes certificate reloads of one resource while the
// manager lock is released for the wait, so the relay and other resources on
// the node are not blocked by an engine that takes a while to reload.
type resourceLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func (r *resourceLocks) lock(id string) func() {
	r.mu.Lock()
	if r.locks == nil {
		r.locks = map[string]*sync.Mutex{}
	}
	lock := r.locks[id]
	if lock == nil {
		lock = &sync.Mutex{}
		r.locks[id] = lock
	}
	r.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}

// lifecycleGenerations counts lifecycle changes per resource (guarded by the
// owning manager's lock). A reload that waited without the lock only acts on
// the resource again (restart, recording the certificate id) when no create,
// update, restart, stop or delete happened in between.
type lifecycleGenerations map[string]uint64

func (g *lifecycleGenerations) bump(id string) uint64 {
	if *g == nil {
		*g = lifecycleGenerations{}
	}
	(*g)[id]++
	return (*g)[id]
}

var errChangedDuringTLSReload = errors.New("the resource changed during the certificate reload; the control plane retries")

// writeFileAtomically replaces path with content through a temporary file in
// the same directory and a rename, so a reader (an engine rereading its
// certificate, or a bind mount of the directory) never sees a truncated or
// partially written file. chown, when set, assigns the temporary file before
// it becomes visible under its final name.
func writeFileAtomically(path string, content []byte, mode os.FileMode, chown func(string) error) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	cleanup := func(cause error) error {
		_ = temporary.Close()
		_ = os.Remove(name)
		return cause
	}
	if _, err := temporary.Write(content); err != nil {
		return cleanup(err)
	}
	if err := temporary.Sync(); err != nil {
		return cleanup(err)
	}
	if err := temporary.Chmod(mode); err != nil {
		return cleanup(err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if chown != nil {
		if err := chown(name); err != nil {
			_ = os.Remove(name)
			return err
		}
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	if dir, err := os.Open(directory); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
