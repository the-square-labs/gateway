// Package update keeps the lease watchdog current on its own release line
// (tags vX.Y.Z-watchdog, component "lease-watchdog"), independently of the
// docker daemon version (A12.5). Artifacts are verified with the same signed
// update manifests as daemon binaries before anything is replaced.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

const (
	// Component is the update-service package name.
	Component = "lease-watchdog"
	// DaemonType is the signed manifest daemonType ("--daemon-type watchdog").
	DaemonType = "watchdog"

	DefaultReleasesURL     = "https://updates.thesqlabs.com/gateway/releases"
	DefaultArtifactBaseURL = "https://updates.thesqlabs.com/gateway"

	maxManifestBytes = 64 * 1024
)

// ReplaceFunc downloads, verifies and atomically writes the artifact to
// destination; lifecycle.ReplaceBinaryAtPath in production.
type ReplaceFunc func(downloadURL, version, sha256, manifest, daemonType, destination string, logger *slog.Logger) error

type Config struct {
	ReleasesURL     string
	ArtifactBaseURL string
	Channel         string
	Current         string
	Executable      string
	HTTP            *http.Client
	Replace         ReplaceFunc
	// SelfTest runs the staged binary before it replaces the running one.
	SelfTest func(ctx context.Context, path string) error
	Logger   *slog.Logger
}

// Result says whether a new binary was installed; the caller then exits so
// the supervisor restarts the watchdog. Records on tmpfs survive the restart.
type Result struct {
	Updated bool
	Tag     string
}

type nextRelease struct {
	Target struct {
		TagName string `json:"tag_name"`
	} `json:"target"`
}

// Check asks the update service for the next watchdog release and installs it.
func Check(ctx context.Context, cfg Config) (Result, error) {
	if cfg.Replace == nil || cfg.SelfTest == nil || cfg.Executable == "" {
		return Result{}, errors.New("watchdog update is not configured")
	}
	if !strings.HasPrefix(cfg.Current, "v") {
		// Development builds are never replaced by release artifacts.
		return Result{}, nil
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: time.Minute}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	tag, err := nextTag(ctx, cfg)
	if err != nil || tag == "" {
		return Result{}, err
	}
	artifact := fmt.Sprintf("lease-watchdog-linux-%s", updateauth.NormalizeArch(runtime.GOARCH))
	base := strings.TrimRight(defaultString(cfg.ArtifactBaseURL, DefaultArtifactBaseURL), "/")
	manifestURL := fmt.Sprintf("%s/%s/%s/%s.update.json", base, Component, url.PathEscape(tag), artifact)
	manifest, err := fetch(ctx, cfg.HTTP, manifestURL, maxManifestBytes)
	if err != nil {
		return Result{}, fmt.Errorf("fetch watchdog update manifest: %w", err)
	}
	payload, err := updateauth.VerifyEnvelope[updateauth.DaemonManifestPayload](manifest)
	if err != nil {
		return Result{}, fmt.Errorf("verify watchdog update manifest: %w", err)
	}
	if payload.DaemonType != DaemonType || payload.Tag != tag || payload.ArtifactName != artifact {
		return Result{}, errors.New("watchdog update manifest does not describe the requested artifact")
	}
	staged := cfg.Executable + ".next"
	defer os.Remove(staged)
	if err := cfg.Replace(payload.DownloadURL, payload.Version, payload.SHA256, manifest, DaemonType, staged, cfg.Logger); err != nil {
		return Result{}, err
	}
	testCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := cfg.SelfTest(testCtx, staged); err != nil {
		return Result{}, fmt.Errorf("staged watchdog %s failed its self-test: %w", tag, err)
	}
	previous := cfg.Executable + ".previous"
	if err := os.Link(cfg.Executable, previous+".tmp"); err == nil {
		_ = os.Rename(previous+".tmp", previous)
	}
	if err := os.Rename(staged, cfg.Executable); err != nil {
		return Result{}, fmt.Errorf("install watchdog %s: %w", tag, err)
	}
	return Result{Updated: true, Tag: tag}, nil
}

func nextTag(ctx context.Context, cfg Config) (string, error) {
	endpoint, err := url.Parse(defaultString(cfg.ReleasesURL, DefaultReleasesURL))
	if err != nil {
		return "", err
	}
	query := endpoint.Query()
	query.Set("component", Component)
	query.Set("current", cfg.Current)
	query.Set("channel", defaultString(cfg.Channel, "stable"))
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", err
	}
	response, err := cfg.HTTP.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent:
		return "", nil
	case http.StatusOK:
	default:
		return "", fmt.Errorf("update service returned status %d", response.StatusCode)
	}
	var next nextRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, maxManifestBytes)).Decode(&next); err != nil {
		return "", fmt.Errorf("decode update service response: %w", err)
	}
	tag := next.Target.TagName
	if !strings.HasSuffix(tag, "-watchdog") || tag == cfg.Current+"-watchdog" {
		return "", nil
	}
	return tag, nil
}

func fetch(ctx context.Context, client *http.Client, target string, limit int64) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
