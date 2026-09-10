package lifecycle

import (
	"os"
	"path/filepath"
	"sync"
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

func TestHostIdentityConcurrentCreationNeverReplacesWinner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway", "host-identity")
	const count = 24
	results := make(chan string, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := loadOrCreateHostIdentity(path)
			if err != nil {
				t.Error(err)
				return
			}
			results <- id
		}()
	}
	wg.Wait()
	close(results)
	var expected string
	for id := range results {
		if expected == "" {
			expected = id
		}
		if id != expected {
			t.Fatalf("conflicting identities: %s / %s", expected, id)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode: %o", info.Mode().Perm())
	}
}
func TestHostIdentityPreservesMalformedExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-identity")
	if err := os.WriteFile(path, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateHostIdentity(path); err == nil {
		t.Fatal("accepted invalid identity")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "broken" {
		t.Fatal("replaced existing identity")
	}
}
