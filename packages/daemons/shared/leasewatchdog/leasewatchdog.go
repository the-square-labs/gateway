// Package leasewatchdog holds what installs and updates the independent lease
// watchdog (A12.5): its install paths, the service definitions and the
// signed release resolution. The node installer (scripts/setup-docker-node.sh)
// is the source of truth for the paths and service files; a test keeps this
// package identical to it. The watchdog's own self-update and the docker
// daemon's bootstrap of a missing watchdog both use it.
package leasewatchdog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

const (
	// BinaryPath and UnitName match LEASE_WATCHDOG_BIN / LEASE_WATCHDOG_UNIT.
	BinaryPath = "/usr/local/bin/gateway-lease-watchdog"
	UnitName   = "gateway-lease-watchdog"
	// SystemdUnitPath and OpenRCPath are where the installer writes them.
	SystemdUnitPath = "/etc/systemd/system/" + UnitName + ".service"
	OpenRCPath      = "/etc/init.d/" + UnitName

	// Component is the update-service package; DaemonType the signed
	// manifest daemonType of its artifacts (tags vX.Y.Z-watchdog).
	Component  = "lease-watchdog"
	DaemonType = "watchdog"

	DefaultReleasesURL     = "https://updates.thesqlabs.com/gateway/releases"
	DefaultArtifactBaseURL = "https://updates.thesqlabs.com/gateway"

	maxResponseBytes = 64 * 1024
)

// RunArgs is the watchdog command line of the service (installer "args").
func RunArgs(recordsOwner, releasesURL, artifactBaseURL string) string {
	return fmt.Sprintf("run --records-owner %s --auto-update --releases-url %s --artifact-base-url %s", recordsOwner, releasesURL, artifactBaseURL)
}

// SystemdUnit is the installer's systemd unit for binary and args.
func SystemdUnit(binary, args string) string {
	return `[Unit]
Description=Gateway Availability Lease Watchdog
# Deliberately independent of docker-daemon and docker: it must keep
# enforcing lease deadlines when either one is stopped, hung or removed.
After=local-fs.target

[Service]
Type=simple
User=root
ExecStart=` + binary + ` ` + args + `
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`
}

// OpenRCScript is the installer's OpenRC service for binary and args.
func OpenRCScript(binary, args string) string {
	return `#!/sbin/openrc-run
name="Gateway Availability Lease Watchdog"
command="` + binary + `"
command_args="` + args + `"
pidfile="/run/${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=1
output_log="/var/log/` + UnitName + `.log"
error_log="/var/log/` + UnitName + `.err"

depend() {
    need localmount
}
`
}

// ArtifactName is the release asset for this architecture.
func ArtifactName() string {
	return "lease-watchdog-linux-" + updateauth.NormalizeArch(runtime.GOARCH)
}

// NextTag asks the update service for the watchdog release to install after
// current ("" for a first install: the latest on the channel). An empty tag
// means no update.
func NextTag(ctx context.Context, client *http.Client, releasesURL, channel, current string) (string, error) {
	endpoint, err := url.Parse(orDefault(releasesURL, DefaultReleasesURL))
	if err != nil {
		return "", err
	}
	query := endpoint.Query()
	query.Set("component", Component)
	if current != "" {
		query.Set("current", current)
	}
	query.Set("channel", orDefault(channel, "stable"))
	endpoint.RawQuery = query.Encode()
	body, status, err := get(ctx, client, endpoint.String())
	if err != nil {
		return "", err
	}
	switch status {
	case http.StatusNoContent:
		return "", nil
	case http.StatusOK:
	default:
		return "", fmt.Errorf("update service returned status %d", status)
	}
	var next struct {
		Target struct {
			TagName string `json:"tag_name"`
		} `json:"target"`
	}
	if err := json.Unmarshal(body, &next); err != nil {
		return "", fmt.Errorf("decode update service response: %w", err)
	}
	tag := next.Target.TagName
	if !strings.HasSuffix(tag, "-"+DaemonType) || (current != "" && tag == current+"-"+DaemonType) {
		return "", nil
	}
	return tag, nil
}

// FetchManifest downloads and verifies the signed update manifest of tag
// against the embedded update trust anchor. Nothing is downloaded or
// installed unless it verifies and names this component's artifact.
func FetchManifest(ctx context.Context, client *http.Client, artifactBaseURL, tag string) (string, *updateauth.DaemonManifestPayload, error) {
	artifact := ArtifactName()
	base := strings.TrimRight(orDefault(artifactBaseURL, DefaultArtifactBaseURL), "/")
	manifestURL := fmt.Sprintf("%s/%s/%s/%s.update.json", base, Component, url.PathEscape(tag), artifact)
	body, status, err := get(ctx, client, manifestURL)
	if err != nil {
		return "", nil, fmt.Errorf("fetch watchdog update manifest: %w", err)
	}
	if status != http.StatusOK {
		return "", nil, fmt.Errorf("fetch watchdog update manifest: status %d", status)
	}
	manifest := string(body)
	payload, err := updateauth.VerifyEnvelope[updateauth.DaemonManifestPayload](manifest)
	if err != nil {
		return "", nil, fmt.Errorf("verify watchdog update manifest: %w", err)
	}
	if payload.DaemonType != DaemonType || payload.Tag != tag || payload.ArtifactName != artifact {
		return "", nil, errors.New("watchdog update manifest does not describe the requested artifact")
	}
	return manifest, payload, nil
}

func get(ctx context.Context, client *http.Client, target string) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	return body, response.StatusCode, err
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
