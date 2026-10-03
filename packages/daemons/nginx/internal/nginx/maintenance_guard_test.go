package nginx

import (
	"os"
	"regexp"
	"testing"
)

func TestEnsureMaintenanceGuardConfigWritesTheSharedMapsOnce(t *testing.T) {
	dir := t.TempDir()
	written, err := EnsureMaintenanceGuardConfig(dir)
	if err != nil || !written {
		t.Fatalf("first ensure: written=%v err=%v", written, err)
	}
	written, err = EnsureMaintenanceGuardConfig(dir)
	if err != nil || written {
		t.Fatalf("an unchanged file was written again: written=%v err=%v", written, err)
	}
	content, err := os.ReadFile(MaintenanceGuardConfigPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	// nginx's default variables_hash_bucket_size (64) takes variable names of up to 46 bytes.
	for _, match := range regexp.MustCompile(`map \S+ \$(\S+) \{`).FindAllStringSubmatch(string(content), -1) {
		if len(match[1]) > 46 {
			t.Fatalf("variable %s is too long for the default variables hash", match[1])
		}
	}
}
