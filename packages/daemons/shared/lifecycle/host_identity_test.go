package lifecycle

import (
	"path/filepath"
	"testing"
)

func TestLoadOrCreateHostIdentityIsStableAcrossColocatedDaemons(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway", "host-identity")
	first, err := loadOrCreateHostIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadOrCreateHostIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("host identity was not stable: first=%q second=%q", first, second)
	}
}
