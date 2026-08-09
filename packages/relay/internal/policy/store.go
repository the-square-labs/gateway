package policy

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
)

var (
	bucketState = []byte("relay-state-v1")
	keySnapshot = []byte("snapshot")
	keyDigest   = []byte("digest")
)

type Snapshot struct {
	Revision          uint64
	GatewayInstanceID string
	PublicKeys        map[string]ed25519.PublicKey
	Endpoints         map[string]*relayv1.EndpointPolicy
	Routes            map[string]*relayv1.RoutePolicy
	Digest            [sha256.Size]byte
}

type Store struct {
	db      *bolt.DB
	mu      sync.RWMutex
	current *Snapshot
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "relay.db"), 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	store := &Store{db: db, current: emptySnapshot()}
	if err := db.Update(func(tx *bolt.Tx) error { _, err := tx.CreateBucketIfNotExists(bucketState); return err }); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.load(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func emptySnapshot() *Snapshot {
	return &Snapshot{PublicKeys: map[string]ed25519.PublicKey{}, Endpoints: map[string]*relayv1.EndpointPolicy{}, Routes: map[string]*relayv1.RoutePolicy{}}
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Current() *Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

func (s *Store) KeyIDs() []string {
	current := s.Current()
	ids := make([]string, 0, len(current.PublicKeys))
	for id := range current.PublicKeys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (s *Store) Apply(request *relayv1.ApplySnapshotRequest) (*Snapshot, bool, error) {
	encoded, digest, next, err := normalize(request)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.current
	if next.Revision < current.Revision {
		return nil, false, fmt.Errorf("snapshot revision %d is older than applied revision %d", next.Revision, current.Revision)
	}
	if next.Revision == current.Revision {
		if bytes.Equal(next.Digest[:], current.Digest[:]) {
			return current, true, nil
		}
		return nil, false, fmt.Errorf("snapshot revision %d conflicts with applied content", next.Revision)
	}
	if err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		if err := bucket.Put(keySnapshot, encoded); err != nil {
			return err
		}
		return bucket.Put(keyDigest, digest[:])
	}); err != nil {
		return nil, false, err
	}
	s.current = next
	return next, false, nil
}

func (s *Store) load() error {
	var encoded []byte
	if err := s.db.View(func(tx *bolt.Tx) error {
		value := tx.Bucket(bucketState).Get(keySnapshot)
		encoded = append([]byte(nil), value...)
		return nil
	}); err != nil {
		return err
	}
	if len(encoded) == 0 {
		return nil
	}
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(encoded, request); err != nil {
		return fmt.Errorf("decode persisted snapshot: %w", err)
	}
	_, _, snapshot, err := normalize(request)
	if err != nil {
		return fmt.Errorf("validate persisted snapshot: %w", err)
	}
	s.current = snapshot
	return nil
}

func normalize(request *relayv1.ApplySnapshotRequest) ([]byte, [sha256.Size]byte, *Snapshot, error) {
	if request == nil {
		return nil, [sha256.Size]byte{}, nil, fmt.Errorf("snapshot is required")
	}
	if request.Revision == 0 {
		return nil, [sha256.Size]byte{}, nil, fmt.Errorf("snapshot revision must be positive")
	}
	if request.GatewayInstanceId == "" {
		return nil, [sha256.Size]byte{}, nil, fmt.Errorf("gateway instance id is required")
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(request)
	if err != nil {
		return nil, [sha256.Size]byte{}, nil, err
	}
	digest := sha256.Sum256(encoded)
	next := &Snapshot{Revision: request.Revision, GatewayInstanceID: request.GatewayInstanceId, PublicKeys: map[string]ed25519.PublicKey{}, Endpoints: map[string]*relayv1.EndpointPolicy{}, Routes: map[string]*relayv1.RoutePolicy{}, Digest: digest}
	for _, key := range request.PublicKeys {
		if key.KeyId == "" || len(key.PublicKey) != ed25519.PublicKeySize {
			return nil, digest, nil, fmt.Errorf("invalid public key")
		}
		if _, exists := next.PublicKeys[key.KeyId]; exists {
			return nil, digest, nil, fmt.Errorf("duplicate public key %q", key.KeyId)
		}
		next.PublicKeys[key.KeyId] = append(ed25519.PublicKey(nil), key.PublicKey...)
	}
	for _, endpoint := range request.Endpoints {
		if endpoint.EndpointId == "" || endpoint.Generation == 0 || endpoint.SubjectKind == "" || endpoint.SubjectId == "" || endpoint.CertificateSha256 == "" {
			return nil, digest, nil, fmt.Errorf("invalid endpoint policy")
		}
		if _, exists := next.Endpoints[endpoint.EndpointId]; exists {
			return nil, digest, nil, fmt.Errorf("duplicate endpoint %q", endpoint.EndpointId)
		}
		next.Endpoints[endpoint.EndpointId] = proto.Clone(endpoint).(*relayv1.EndpointPolicy)
	}
	for _, route := range request.Routes {
		if route.RouteId == "" || route.Generation == 0 || route.SourceKind == "" || route.SourceId == "" || route.SourceCertificateSha256 == "" {
			return nil, digest, nil, fmt.Errorf("invalid route policy")
		}
		if _, ok := next.Endpoints[route.TargetEndpointId]; !ok {
			return nil, digest, nil, fmt.Errorf("route %q targets unknown endpoint", route.RouteId)
		}
		if _, exists := next.Routes[route.RouteId]; exists {
			return nil, digest, nil, fmt.Errorf("duplicate route %q", route.RouteId)
		}
		next.Routes[route.RouteId] = proto.Clone(route).(*relayv1.RoutePolicy)
	}
	return encoded, digest, next, nil
}

func RevisionBytes(revision uint64) []byte {
	value := make([]byte, 8)
	binary.BigEndian.PutUint64(value, revision)
	return value
}
