package leasewatchdog

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

const installerPath = "../../../../scripts/setup-docker-node.sh"

// heredoc returns the body of the first heredoc that follows marker.
func heredoc(t *testing.T, script, marker string) string {
	t.Helper()
	start := strings.Index(script, marker)
	if start < 0 {
		t.Fatalf("installer has no %q", marker)
	}
	body := script[start+len(marker):]
	body = body[strings.Index(body, "\n")+1:]
	end := strings.Index(body, "\nUNIT\n")
	if end < 0 {
		t.Fatal("unterminated heredoc")
	}
	return body[:end+1]
}

// The installer is the source of truth: the daemon's bootstrap must write the
// same binary path, unit name and service files.
func TestServiceDefinitionsMatchTheNodeInstaller(t *testing.T) {
	data, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	for name, want := range map[string]string{"LEASE_WATCHDOG_BIN": BinaryPath, "LEASE_WATCHDOG_UNIT": UnitName} {
		if !strings.Contains(script, name+`="`+want+`"`) {
			t.Fatalf("installer %s differs from %q", name, want)
		}
	}
	argsLine := regexp.MustCompile(`local args="([^"]+)"`).FindStringSubmatch(script)
	if argsLine == nil || argsLine[1] != RunArgs("${RUN_USER}", "${RELEASES_API_URL}", "${ARTIFACT_BASE_URL}") {
		t.Fatalf("installer watchdog args %q differ from RunArgs", argsLine)
	}
	replacer := strings.NewReplacer("${LEASE_WATCHDOG_BIN}", BinaryPath, "${args}", "ARGS", "${LEASE_WATCHDOG_UNIT}", UnitName, `\${RC_SVCNAME}`, "${RC_SVCNAME}")
	systemd := replacer.Replace(heredoc(t, script, `cat > "/etc/systemd/system/${LEASE_WATCHDOG_UNIT}.service" <<UNIT`))
	if systemd != SystemdUnit(BinaryPath, "ARGS") {
		t.Fatalf("systemd unit differs from the installer:\n%s\n---\n%s", systemd, SystemdUnit(BinaryPath, "ARGS"))
	}
	openrc := replacer.Replace(heredoc(t, script, `cat > "/etc/init.d/${LEASE_WATCHDOG_UNIT}" <<UNIT`))
	if openrc != OpenRCScript(BinaryPath, "ARGS") {
		t.Fatalf("OpenRC script differs from the installer:\n%s\n---\n%s", openrc, OpenRCScript(BinaryPath, "ARGS"))
	}
}

type fakeTransport map[string]string

func (f fakeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	for prefix, body := range f {
		if strings.HasPrefix(request.URL.String(), prefix) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
		}
	}
	return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader(""))}, nil
}

func TestReleaseResolutionAndForgedManifest(t *testing.T) {
	client := &http.Client{Transport: fakeTransport{"https://u.test/releases": `{"target":{"tag_name":"v2.0.1-watchdog"}}`}}
	tag, err := NextTag(context.Background(), client, "https://u.test/releases", "stable", "")
	if err != nil || tag != "v2.0.1-watchdog" {
		t.Fatalf("tag %q err %v", tag, err)
	}
	if tag, _ := NextTag(context.Background(), &http.Client{Transport: fakeTransport{}}, "https://u.test/releases", "", "v2.0.1"); tag != "" {
		t.Fatal("no content means no release")
	}
	_, forged, _ := ed25519.GenerateKey(rand.Reader)
	payload, _ := json.Marshal(updateauth.DaemonManifestPayload{Kind: "daemon-binary", DaemonType: DaemonType, Tag: tag, ArtifactName: ArtifactName()})
	envelope, _ := json.Marshal(updateauth.SignPayload(forged, payload))
	client = &http.Client{Transport: fakeTransport{"https://u.test/gateway/lease-watchdog/": string(envelope)}}
	if _, _, err := FetchManifest(context.Background(), client, "https://u.test/gateway", tag); err == nil {
		t.Fatal("a manifest not signed by the update key must be rejected")
	}
}
