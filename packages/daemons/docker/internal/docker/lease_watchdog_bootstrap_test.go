package docker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/daemon-shared/leasewatchdog"
	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// bootstrapHost records every host action of a bootstrap.
type bootstrapHost struct {
	files     map[string]bool
	written   map[string]string
	commands  []string
	replaced  int
	heartbeat bool
	root      bool
	manager   string
}

func newBootstrapForTest(host *bootstrapHost) *watchdogBootstrap {
	b := newWatchdogBootstrap(slog.New(slog.NewTextHandler(io.Discard, nil)), func() bool { return host.heartbeat }, "https://u.test/releases", "https://u.test/gateway")
	b.exists = func(path string) bool { return host.files[path] }
	b.euid = func() int {
		if host.root {
			return 0
		}
		return 1000
	}
	b.serviceManager = func() string { return host.manager }
	b.recordsOwner = func() string { return "root" }
	b.fetch = func(context.Context) (string, *updateauth.DaemonManifestPayload, error) {
		return "manifest", &updateauth.DaemonManifestPayload{DownloadURL: "https://u.test/gateway/lease-watchdog/v2.0.0-watchdog/a", Version: "v2.0.0", SHA256: strings.Repeat("a", 64)}, nil
	}
	b.replace = func(downloadURL, version, sha256, manifest, daemonType, destination string, _ *slog.Logger) error {
		if daemonType != leasewatchdog.DaemonType || destination != leasewatchdog.BinaryPath+".next" || manifest != "manifest" {
			return errors.New("unexpected replace")
		}
		host.replaced++
		host.files[destination] = true
		return nil
	}
	b.selfTest = func(context.Context, string) error { return nil }
	b.rename = func(from, to string) error {
		delete(host.files, from)
		host.files[to] = true
		return nil
	}
	b.remove = func(path string) error { delete(host.files, path); return nil }
	b.writeFile = func(path string, data []byte, _ os.FileMode) error {
		host.files[path] = true
		host.written[path] = string(data)
		return nil
	}
	b.run = func(_ context.Context, name string, args ...string) error {
		host.commands = append(host.commands, name+" "+strings.Join(args, " "))
		if name == "systemctl" && len(args) > 0 && args[0] == "start" {
			host.heartbeat = true // the watchdog starts writing its heartbeat
		}
		return nil
	}
	b.wait = func(ctx context.Context, _ time.Duration) bool { return ctx.Err() == nil }
	return b
}

func newBootstrapHost() *bootstrapHost {
	return &bootstrapHost{files: map[string]bool{}, written: map[string]string{}, root: true, manager: "systemd"}
}

func TestMissingWatchdogIsBootstrappedWithTheInstallerUnit(t *testing.T) {
	host := newBootstrapHost()
	b := newBootstrapForTest(host)
	present := false
	b.onPresent = func() { present = true }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b.Run(ctx)
	if host.replaced != 1 || !host.files[leasewatchdog.BinaryPath] || host.files[leasewatchdog.BinaryPath+".next"] {
		t.Fatalf("the verified release must be staged and installed at %s: %+v", leasewatchdog.BinaryPath, host)
	}
	wantUnit := leasewatchdog.SystemdUnit(leasewatchdog.BinaryPath, leasewatchdog.RunArgs("root", "https://u.test/releases", "https://u.test/gateway"))
	if host.written[leasewatchdog.SystemdUnitPath] != wantUnit {
		t.Fatalf("unit differs from the installer's:\n%s", host.written[leasewatchdog.SystemdUnitPath])
	}
	want := []string{"systemctl daemon-reload", "systemctl enable gateway-lease-watchdog", "systemctl start gateway-lease-watchdog"}
	if strings.Join(host.commands, "|") != strings.Join(want, "|") {
		t.Fatalf("service commands %v", host.commands)
	}
	if !present {
		t.Fatal("a watchdog that appeared must refresh the node registration")
	}
}

func TestExistingWatchdogIsNeverTouched(t *testing.T) {
	for name, host := range map[string]*bootstrapHost{
		"running":             {files: map[string]bool{}, written: map[string]string{}, root: true, manager: "systemd", heartbeat: true},
		"binary but stopped":  {files: map[string]bool{leasewatchdog.BinaryPath: true}, written: map[string]string{}, root: true, manager: "systemd"},
		"unit but no binary":  {files: map[string]bool{leasewatchdog.SystemdUnitPath: true}, written: map[string]string{}, root: true, manager: "systemd"},
		"openrc service only": {files: map[string]bool{leasewatchdog.OpenRCPath: true}, written: map[string]string{}, root: true, manager: "openrc"},
	} {
		b := newBootstrapForTest(host)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		polls := 0
		b.wait = func(ctx context.Context, _ time.Duration) bool {
			polls++
			return polls < 3 && ctx.Err() == nil
		}
		b.Run(ctx)
		cancel()
		if host.replaced != 0 || len(host.written) != 0 || len(host.commands) != 0 {
			t.Fatalf("%s: an existing watchdog must never be updated, rewritten or restarted: %+v", name, host)
		}
		if unavailable, _ := b.Unavailable(); unavailable {
			t.Fatalf("%s: an installed watchdog is not reported missing", name)
		}
	}
}

func TestUnprivilegedDaemonReportsWhyTheWatchdogIsMissing(t *testing.T) {
	host := newBootstrapHost()
	host.root = false
	b := newBootstrapForTest(host)
	unavailable, reason := b.Unavailable()
	if !unavailable || !strings.Contains(reason, "re-run the node installer") {
		t.Fatalf("unavailable %v reason %q", unavailable, reason)
	}
	ctx, cancel := context.WithCancel(context.Background())
	polls := 0
	b.wait = func(context.Context, time.Duration) bool { polls++; return polls < 2 }
	b.Run(ctx)
	cancel()
	if host.replaced != 0 || len(host.commands) != 0 {
		t.Fatal("a daemon without root must not try to install")
	}
	plugin := availabilityPluginForTest(t)
	plugin.lease = &leaseIntegration{plugin: plugin, fence: leaseFenceNeverFresh(t), watchdog: b}
	if capabilities := plugin.leaseCapabilities(); len(capabilities) != 1 || capabilities[0] != watchdogMissingCapability {
		t.Fatalf("capabilities %v, want the missing-watchdog marker", capabilities)
	}
	host.manager = ""
	host.root = true
	if unavailable, reason := b.Unavailable(); !unavailable || !strings.Contains(reason, "systemd or OpenRC") {
		t.Fatalf("no service manager: %v %q", unavailable, reason)
	}
}

func TestForgedWatchdogReleaseIsNeverInstalled(t *testing.T) {
	host := newBootstrapHost()
	b := newBootstrapForTest(host)
	_, forged, _ := ed25519.GenerateKey(rand.Reader)
	payload, _ := json.Marshal(updateauth.DaemonManifestPayload{Kind: "daemon-binary", DaemonType: leasewatchdog.DaemonType, Tag: "v2.0.0-watchdog", ArtifactName: leasewatchdog.ArtifactName()})
	envelope, _ := json.Marshal(updateauth.SignPayload(forged, payload))
	client := &http.Client{Transport: routeTransport{
		"https://u.test/releases":                    `{"target":{"tag_name":"v2.0.0-watchdog"}}`,
		"https://u.test/gateway/lease-watchdog/v2.0": string(envelope),
	}}
	b.fetch = func(ctx context.Context) (string, *updateauth.DaemonManifestPayload, error) {
		tag, err := leasewatchdog.NextTag(ctx, client, b.releasesURL, b.channel, "")
		if err != nil {
			return "", nil, err
		}
		return leasewatchdog.FetchManifest(ctx, client, b.artifactBaseURL, tag)
	}
	if err := b.install(context.Background()); err == nil {
		t.Fatal("a manifest not signed by the update key must fail the bootstrap")
	}
	if host.replaced != 0 || len(host.written) != 0 || len(host.commands) != 0 || host.files[leasewatchdog.BinaryPath] {
		t.Fatalf("nothing may be installed from an unverified release: %+v", host)
	}
}

func TestBootstrapRetryIsJittered(t *testing.T) {
	seen := map[time.Duration]bool{}
	for i := 0; i < 50; i++ {
		d := jittered(time.Minute)
		if d < 45*time.Second || d > 75*time.Second {
			t.Fatalf("jitter %s outside ±25%%", d)
		}
		seen[d] = true
	}
	if len(seen) < 5 {
		t.Fatal("retries must be spread")
	}
	host := newBootstrapHost()
	b := newBootstrapForTest(host)
	b.fetch = func(context.Context) (string, *updateauth.DaemonManifestPayload, error) {
		return "", nil, errors.New("offline")
	}
	var waits []time.Duration
	b.wait = func(_ context.Context, d time.Duration) bool {
		waits = append(waits, d)
		return len(waits) < 4
	}
	b.Run(context.Background())
	if len(waits) != 4 || waits[1] <= waits[0]/2 || waits[3] < bootstrapRetryMin*4*3/4 {
		t.Fatalf("download failures must back off with jitter, waits %v", waits)
	}
}

func leaseFenceNeverFresh(t *testing.T) lease.DirFence {
	return lease.DirFence{Dir: leasefence.Dir{Root: t.TempDir()}}
}

type routeTransport map[string]string

func (f routeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	for prefix, body := range f {
		if strings.HasPrefix(request.URL.String(), prefix) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
		}
	}
	return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(""))}, nil
}
