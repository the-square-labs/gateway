package availabilitylease

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Store persists acceptor and proposer state. Apply must be atomic and
// durable (fsync) before it returns: the node writes promised ballots through
// it before replying (A3). The relay backs it with a relay.db bucket, the
// docker and nginx daemons with a file in their state directory.
type Store interface {
	// Load returns every record. An empty map means fresh state.
	Load() (map[string][]byte, error)
	// Apply writes puts and removes deletes in one durable transaction.
	Apply(puts map[string][]byte, deletes []string) error
}

const (
	recordIncarnation = "incarnation"
	recordKeyChain    = "keychain"
	// recordBootStamp proves on restart that the store was written earlier
	// in the same boot (lease clock origin and reading, and the abstention
	// deadline then in force); older builds never write it.
	recordBootStamp = "bootstamp"
	prefixVoters    = "voters/"
	prefixManifest  = "manifest/"
	prefixKey       = "key/"
	prefixLink      = "link/"
)

type bootStamp struct {
	origin       uint64
	clock        time.Duration
	abstainUntil time.Duration
}

func (n *Node) bootStamp(now time.Duration) []byte {
	data := make([]byte, 24)
	binary.BigEndian.PutUint64(data[0:], n.clockOrigin)
	binary.BigEndian.PutUint64(data[8:], uint64(now))
	binary.BigEndian.PutUint64(data[16:], uint64(n.abstainUntil))
	return data
}

func decodeBootStamp(data []byte) (bootStamp, bool) {
	if len(data) != 24 {
		return bootStamp{}, false
	}
	return bootStamp{
		origin:       binary.BigEndian.Uint64(data[0:]),
		clock:        time.Duration(binary.BigEndian.Uint64(data[8:])),
		abstainUntil: time.Duration(binary.BigEndian.Uint64(data[16:])),
	}, true
}

// keyRecord is the persisted acceptor state of one key. The hold of the last
// counted accept is persisted with its lease clock reading; a restart on
// another boot cannot use it and abstains instead (A3).
type keyRecord struct {
	Promised           Ballot            `json:"promised"`
	Released           map[string]Ballot `json:"released,omitempty"`
	BootstrapSatisfied uint64            `json:"bootstrapSatisfied,omitempty"`
	Commit             []byte            `json:"commit,omitempty"`
	// Accepted is this acceptor's latest counted accept and its lease
	// clock reading; after a restart within the same boot it restores the
	// hold exactly (restoreHolds). Older builds ignore it.
	Accepted *acceptedRecord `json:"accepted,omitempty"`
}

type acceptedRecord struct {
	Ballot Ballot `json:"ballot"`
	AtNs   int64  `json:"atNs"`
}

func keyRecordName(key Key) string { return fmt.Sprintf("%s%s/%d", prefixKey, key.PolicyID, key.Slot) }

func encodeKeyRecord(record keyRecord) []byte {
	data, _ := json.Marshal(record)
	return data
}

func decodeKeyRecord(data []byte) (keyRecord, error) {
	var record keyRecord
	err := json.Unmarshal(data, &record)
	return record, err
}

func encodeUint64(value uint64) []byte {
	data := make([]byte, 8)
	binary.BigEndian.PutUint64(data, value)
	return data
}

func decodeUint64(data []byte) (uint64, error) {
	if len(data) != 8 {
		return 0, fmt.Errorf("invalid counter record")
	}
	return binary.BigEndian.Uint64(data), nil
}

// MemoryStore is an in-memory Store for tests and simulations.
type MemoryStore struct {
	mu     sync.Mutex
	data   map[string][]byte
	writes int
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{data: map[string][]byte{}} }

func (m *MemoryStore) Load() (map[string][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string][]byte, len(m.data))
	for key, value := range m.data {
		out[key] = append([]byte(nil), value...)
	}
	return out, nil
}

func (m *MemoryStore) Apply(puts map[string][]byte, deletes []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, key := range deletes {
		delete(m.data, key)
	}
	for key, value := range puts {
		m.data[key] = append([]byte(nil), value...)
	}
	m.writes++
	return nil
}

// Wipe drops every record, like renaming relay.db.
func (m *MemoryStore) Wipe() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data = map[string][]byte{}
}

// Writes counts durable transactions.
func (m *MemoryStore) Writes() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writes
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
