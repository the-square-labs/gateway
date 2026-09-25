package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

// managedStorageTLSReloadCommand is the `reload_tls` payload: renewed TLS
// material for one cluster member. It is applied without recreating the
// container; allowRestart permits a restart only when the engine does not
// serve the staged certificate on its own.
type managedStorageTLSReloadCommand struct {
	Version      int               `json:"version"`
	TLS          managedStorageTLS `json:"tls"`
	AllowRestart bool              `json:"allowRestart"`
}

func parseManagedStorageTLSReloadCommand(raw string) (managedStorageTLSReloadCommand, servedCertificate, error) {
	var input managedStorageTLSReloadCommand
	if raw == "" {
		return input, servedCertificate{}, errors.New("managed storage TLS reload config is required")
	}
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return input, servedCertificate{}, fmt.Errorf("parse managed storage TLS reload config: %w", err)
	}
	if input.Version != 1 {
		return input, servedCertificate{}, errors.New("managed storage TLS reload config version must be 1")
	}
	if input.TLS.CertPEM == "" || input.TLS.KeyPEM == "" || input.TLS.CAPEM == "" || input.TLS.ServerName == "" {
		return input, servedCertificate{}, errors.New("managed storage TLS requires certificate, key, CA and server name")
	}
	leaf, err := leafCertificateFingerprint(input.TLS.CertPEM, input.TLS.KeyPEM)
	if err != nil {
		return input, servedCertificate{}, err
	}
	return input, leaf, nil
}

// handleTLSReload stages renewed material and makes the running engine serve
// it: SeaweedFS rereads its certificate files on its own refresh interval,
// legacy MinIO reloads them on SIGHUP. Staging and the trigger run under the
// manager lock; waiting for the engine (and a restart fallback's readiness)
// does not, so relay connections to every cluster on the node keep flowing.
// The result names the certificate actually served afterwards.
func (m *managedStorageManager) handleTLSReload(ctx context.Context, id, configJSON string) (string, error) {
	input, leaf, err := parseManagedStorageTLSReloadCommand(configJSON)
	if err != nil {
		return "", err
	}
	unlockResource := m.tlsReloads.lock(id)
	defer unlockResource()

	m.mu.Lock()
	record, err := m.loadRecord(id)
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	plan, err := m.tlsReloadPlan(ctx, &record, input, leaf)
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	generation := m.generations.bump(id)
	triggerErr, err := prepareTLSReload(ctx, plan)
	if err == nil {
		// The staged files now carry the new server name.
		err = m.saveRecord(record)
	}
	m.mu.Unlock()
	if err != nil {
		return "", err
	}

	snapshot := record
	plan.Restart = func(ctx context.Context) error {
		m.mu.Lock()
		current, err := m.loadRecord(id)
		if err != nil || current.Removed || current.ContainerID != snapshot.ContainerID || m.generations[id] != generation {
			m.mu.Unlock()
			return errChangedDuringTLSReload
		}
		err = m.client.StopContainer(ctx, snapshot.ContainerID, 20)
		if err == nil {
			err = m.startContainer(ctx, snapshot.ContainerID)
		}
		m.mu.Unlock()
		if err != nil {
			return err
		}
		return m.waitForReady(ctx, snapshot)
	}
	result, err := awaitTLSReload(ctx, plan, triggerErr)
	if err != nil {
		return "", err
	}
	return jsonString(result)
}

// tlsReloadPlan validates the running member and builds its reload plan. The
// record's server name is updated for the material being staged.
func (m *managedStorageManager) tlsReloadPlan(ctx context.Context, record *managedStorageRecord, input managedStorageTLSReloadCommand, leaf servedCertificate) (tlsReloadPlan, error) {
	if record.Removed {
		return tlsReloadPlan{}, errors.New("managed storage was removed")
	}
	if !record.TLSEnabled {
		return tlsReloadPlan{}, errors.New("managed storage TLS is not enabled; enable it with an update")
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return tlsReloadPlan{}, errors.New("managed storage container is not running")
	}
	if err := m.verifyOwnedContainer(ctx, *record); err != nil {
		return tlsReloadPlan{}, err
	}
	record.TLSServerName = input.TLS.ServerName
	snapshot := *record
	plan := tlsReloadPlan{
		Expected:     leaf.FingerprintSHA256,
		AllowRestart: input.AllowRestart,
		Probe:        func(ctx context.Context) (servedCertificate, error) { return m.probeTLS(ctx, snapshot) },
		Wait:         managedTLSReloadWait,
	}
	if record.engine() == managedStorageEngineSeaweedFS {
		interval := seaweedfsContainerTLSRefreshInterval(inspect.Container.Config)
		plan.Method = tlsReloadMethodFileWatch
		plan.ReloadInterval = interval
		plan.Stage = func() error {
			_, err := m.restageSeaweedFSTLS(snapshot, input.TLS)
			return err
		}
		// The engine rereads the files on its next tick; the daemon waits
		// briefly and otherwise reports `pending`, and the control plane
		// checks again with the same material. With the upstream default (5h)
		// only one probe is made.
		if interval > managedTLSMaximumReloadWait {
			plan.Wait = managedTLSProbeInterval
		}
	} else {
		plan.Method = tlsReloadMethodSignal
		plan.Stage = func() error {
			_, err := m.stageTLS(snapshot, input.TLS)
			return err
		}
		plan.Trigger = func(ctx context.Context) error {
			// MinIO reloads the certificates in --certs-dir on SIGHUP without
			// restarting the server process.
			return m.client.KillContainer(ctx, snapshot.ContainerID, "SIGHUP")
		}
	}
	return plan, nil
}

// handleTLSProbe reports the certificate a member serves; the probe itself
// runs without the manager lock.
func (m *managedStorageManager) handleTLSProbe(ctx context.Context, id string) (string, error) {
	m.mu.Lock()
	record, err := m.loadRecord(id)
	m.mu.Unlock()
	if err != nil {
		return "", err
	}
	if record.Removed {
		return "", errors.New("managed storage was removed")
	}
	served, err := m.probeTLS(ctx, record)
	if err != nil {
		return "", fmt.Errorf("probe managed storage TLS: %w", err)
	}
	return jsonString(served)
}

// seaweedfsContainerTLSRefreshInterval reads the container's certificate
// refresh interval; containers created before it was set use the upstream
// five-hour default.
func seaweedfsContainerTLSRefreshInterval(config *container.Config) time.Duration {
	if config == nil {
		return 5 * time.Hour
	}
	for _, entry := range config.Env {
		value, ok := strings.CutPrefix(entry, "WEED_TLS_CERT_REFRESH_INTERVAL=")
		if !ok {
			continue
		}
		if interval, err := time.ParseDuration(value); err == nil && interval > 0 {
			return interval
		}
	}
	return 5 * time.Hour
}

// probeTLS returns the certificate the member serves on its private S3
// listener.
func (m *managedStorageManager) probeTLS(ctx context.Context, record managedStorageRecord) (servedCertificate, error) {
	if !record.TLSEnabled {
		return servedCertificate{}, errors.New("managed storage TLS is not enabled")
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return servedCertificate{}, err
	}
	if m.probeServed != nil {
		return m.probeServed(ctx, endpoint, managedTLSProtocolDirect)
	}
	return probeServedCertificate(ctx, endpoint, managedTLSProtocolDirect)
}
