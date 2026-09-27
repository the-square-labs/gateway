package daemon

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

// availabilityLeaseStateFile holds this node's persisted availability-lease
// acceptor and identity state (A3, A16): the promised ballot per key and the
// incarnation, so a restart abstains instead of forging a fresh vote.
const availabilityLeaseStateFile = "availability-lease-state.json"

// availabilityLeaseFileStore implements availabilitylease.Store on a single
// JSON file in the daemon state directory. Every write goes through
// nginx.WriteAtomic, which fsyncs the temporary file before the rename that
// publishes it, so a promised ballot is durable before any reply leaves (A3).
type availabilityLeaseFileStore struct {
	mu   sync.Mutex
	path string
}

func newAvailabilityLeaseFileStore(stateDir string) *availabilityLeaseFileStore {
	return &availabilityLeaseFileStore{path: filepath.Join(stateDir, availabilityLeaseStateFile)}
}

// Load returns every persisted record. A missing file means fresh state.
func (s *availabilityLeaseFileStore) Load() (map[string][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *availabilityLeaseFileStore) loadLocked() (map[string][]byte, error) {
	data, err := nginx.ReadFile(s.path)
	if err != nil {
		return nil, fmt.Errorf("read availability lease state: %w", err)
	}
	if data == nil {
		return map[string][]byte{}, nil
	}
	encoded := map[string]string{}
	if err := json.Unmarshal(data, &encoded); err != nil {
		return nil, fmt.Errorf("decode availability lease state: %w", err)
	}
	records := make(map[string][]byte, len(encoded))
	for key, value := range encoded {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("decode availability lease record %q: %w", key, err)
		}
		records[key] = decoded
	}
	return records, nil
}

// Apply writes puts and removes deletes in one durable transaction: the
// entire record set is rewritten and fsynced before this returns (A3). A
// failed write returns an error, and the caller (the Node) never sends the
// reply it would have depended on.
func (s *availabilityLeaseFileStore) Apply(puts map[string][]byte, deletes []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadLocked()
	if err != nil {
		return err
	}
	for _, key := range deletes {
		delete(records, key)
	}
	for key, value := range puts {
		records[key] = append([]byte(nil), value...)
	}
	encoded := make(map[string]string, len(records))
	for key, value := range records {
		encoded[key] = base64.StdEncoding.EncodeToString(value)
	}
	data, err := json.Marshal(encoded)
	if err != nil {
		return fmt.Errorf("encode availability lease state: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create availability lease state directory: %w", err)
	}
	if err := nginx.WriteAtomic(s.path, data); err != nil {
		return fmt.Errorf("persist availability lease state: %w", err)
	}
	return nil
}
