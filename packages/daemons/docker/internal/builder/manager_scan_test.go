package builder

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

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
