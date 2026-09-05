package lifecycle

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveRecognizedLegacyMarkerPreservesUnknownFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daemon.update-state.json")
	if err := os.WriteFile(path, []byte(`{"schemaVersion":2,"targetVersion":"v2"}`), 0600); err != nil {
		t.Fatal(err)
	}
	removed, err := removeRecognizedLegacyMarker(path, ".update-state.json", os.Geteuid())
	if err == nil || removed {
		t.Fatalf("unknown marker removed=%v err=%v", removed, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("unknown marker was not preserved: %v", err)
	}
}

func TestRemoveRecognizedLegacyMarkers(t *testing.T) {
	for _, test := range []struct {
		suffix   string
		contents string
	}{
		{suffix: ".update-state.json", contents: `{"schemaVersion":1,"fromVersion":"v1","targetVersion":"v2"}`},
		{suffix: ".update-pending", contents: "v2.10.0-rc.29\n"},
		{suffix: ".update-outcome.json", contents: `{"schemaVersion":1,"fromVersion":"v1","targetVersion":"v2","status":"rolled_back"}`},
	} {
		t.Run(test.suffix, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "daemon"+test.suffix)
			if err := os.WriteFile(path, []byte(test.contents), 0600); err != nil {
				t.Fatal(err)
			}
			removed, err := removeRecognizedLegacyMarker(path, test.suffix, os.Geteuid())
			if err != nil || !removed {
				t.Fatalf("removed=%v err=%v", removed, err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("recognized marker still exists: %v", err)
			}
		})
	}
}

func TestRemoveRecognizedLegacyDropInRequiresExactGuardContent(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "docker-daemon")
	dropIn := filepath.Join(t.TempDir(), "20-update-rollback.conf")
	contents := "[Service]\nExecStartPre=+" + binary + " update-guard start # 20-update-rollback\n"
	if err := os.WriteFile(dropIn, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	removed, err := removeRecognizedLegacyDropIn(dropIn, binary, os.Geteuid())
	if err != nil || !removed {
		t.Fatalf("removed=%v err=%v", removed, err)
	}
}
