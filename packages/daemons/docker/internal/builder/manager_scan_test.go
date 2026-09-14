package builder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/proto"
)

func TestDisabledScanDoesNotInvokeImageScanners(t *testing.T) {
	calls := 0
	manager := &Manager{executable: func(name string) (string, error) {
		calls++
		return "", errors.New("scanner invoked")
	}}
	encoded, err := proto.Marshal(&pb.DockerBuildCommand{SkipVulnerabilityScan: true})
	if err != nil {
		t.Fatal(err)
	}
	command := &pb.DockerBuildCommand{}
	if err := proto.Unmarshal(encoded, command); err != nil {
		t.Fatal(err)
	}
	summary, err := manager.scan(context.Background(), command, t.TempDir(), "", "")
	if err != nil || calls != 0 || summary != `{"scanner":"disabled","skipped":true}` {
		t.Fatalf("disabled scan executed a tool or lost its marker: calls=%d summary=%s err=%v", calls, summary, err)
	}
	// Missing/false flag is the legacy/default and report-only behavior.
	_, err = manager.scan(context.Background(), &pb.DockerBuildCommand{}, t.TempDir(), "registry/app:tag", "sha256:abc")
	if err == nil || calls != 1 {
		t.Fatalf("default scan did not invoke Syft: calls=%d err=%v", calls, err)
	}
}

func TestGrypeOSCountsCoverFullReportAndPreserveApplicationFindings(t *testing.T) {
	matches := make([]map[string]any, 0)
	for i := 0; i < 104; i++ {
		packageType := []string{"deb", "rpm", "apk", "alpm"}[i%4]
		if i == 101 {
			packageType = "npm"
		}
		if i == 102 {
			packageType = "binary"
		}
		if i == 103 {
			packageType = "unknown"
		}
		matches = append(matches, map[string]any{
			"vulnerability": map[string]any{"id": fmt.Sprintf("CVE-%04d", i), "severity": "Critical"},
			"artifact":      map[string]any{"name": "package", "type": packageType},
		})
	}
	data, err := json.Marshal(map[string]any{"matches": matches})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "scan.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	encoded, err := summarizeGrype(path)
	if err != nil {
		t.Fatal(err)
	}
	var summary struct {
		Critical   int `json:"critical"`
		OSPackages struct {
			Critical int `json:"critical"`
		} `json:"osPackages"`
		Vulnerabilities []map[string]any `json:"vulnerabilities"`
		Truncated       int              `json:"vulnerabilitiesTruncated"`
	}
	if err := json.Unmarshal([]byte(encoded), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Critical != 104 || summary.OSPackages.Critical != 101 || summary.Truncated != 4 || len(summary.Vulnerabilities) != 100 {
		t.Fatalf("full counters or retained report are incorrect: %s", encoded)
	}
}
