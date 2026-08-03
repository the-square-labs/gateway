package install

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/installer/internal/config"
)

func TestChecksumForAcceptsPlainAndStarredAssets(t *testing.T) {
	contents := []byte("aabb asset-a\nccdd *asset-b\n")
	if got := checksumFor(contents, "asset-a"); got != "aabb" {
		t.Fatalf("plain checksum = %q", got)
	}
	if got := checksumFor(contents, "asset-b"); got != "ccdd" {
		t.Fatalf("starred checksum = %q", got)
	}
}

func TestValidateStorageRoot(t *testing.T) {
	if err := validateStorageRoot("/"); err == nil {
		t.Fatal("root must be rejected")
	}
	if err := validateStorageRoot("relative"); err == nil {
		t.Fatal("relative path must be rejected")
	}
	if err := validateStorageRoot("/mnt/databases"); err != nil {
		t.Fatal(err)
	}
}

func TestCopyWithProgressReportsSizeAndCompletion(t *testing.T) {
	var destination bytes.Buffer
	var output bytes.Buffer
	contents := strings.Repeat("x", 1024)
	if err := copyWithProgress(&destination, strings.NewReader(contents), "nginx-daemon", int64(len(contents)), &output); err != nil {
		t.Fatal(err)
	}
	if destination.String() != contents {
		t.Fatal("downloaded contents do not match")
	}
	if !strings.Contains(output.String(), "Downloading nginx-daemon: 1.0 KB / 1.0 KB (100%)") {
		t.Fatalf("progress output = %q", output.String())
	}
}

func TestDaemonReleasePreservesDaemonRCReleaseTag(t *testing.T) {
	name, tag, err := daemonRelease(config.Node{Type: config.NodeNginx, Version: "v2.5.0-nginx-rc.1"})
	if err != nil {
		t.Fatal(err)
	}
	if name != "nginx-daemon" || tag != "v2.5.0-nginx-rc.1" {
		t.Fatalf("daemon release = %q, %q", name, tag)
	}
}

func TestResolveDaemonTagSelectsLatestMatchingReleaseCandidate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/api/v4/projects/group%2Fproject/releases" {
			t.Fatalf("request path = %s", request.URL.EscapedPath())
		}
		_, _ = writer.Write([]byte(`[
			{"tag_name":"v2.5.0-nginx-rc.2"},
			{"tag_name":"v2.5.0-nginx-rc.10"},
			{"tag_name":"v2.5.1-docker-rc.1"},
			{"tag_name":"v2.5.0-nginx"}
		]`))
	}))
	defer server.Close()

	tag, err := resolveDaemonTag(server.Client(), config.Node{
		Type:          config.NodeNginx,
		Version:       "nightly",
		GitLabURL:     server.URL,
		GitLabProject: "group/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	if tag != "v2.5.0-nginx-rc.10" {
		t.Fatalf("release candidate tag = %q", tag)
	}
}
