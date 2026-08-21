package policy

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
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

const (
	PolicyLease       = 15 * time.Minute
	IssuedAtClockSkew = 5 * time.Minute
	PoolCapability    = "relay_pool_v1"
)

var (
	bucketState    = []byte("relay-state-v1")
	keySnapshot    = []byte("snapshot")
	keyDigest      = []byte("digest")
	keyPolicyTrust = []byte("policy-trust")
)

type Options struct {
	Mode       relayv1.RelayMode
	PoolID     string
	InstanceID string
	Now        func() time.Time
}

type Snapshot struct {
	SchemaVersion       uint32
	Mode                relayv1.RelayMode
	Revision            uint64
	GatewayInstanceID   string
	PoolID              string
	RelayInstanceID     string
	IssuedAt            time.Time
	ExpiresAt           time.Time
	Capabilities        []string
	PublicKeys          map[string]ed25519.PublicKey
	Endpoints           map[string]*relayv1.EndpointPolicy
	Routes              map[string]*relayv1.RoutePolicy
	EndpointAssignments map[string]*relayv1.EndpointPolicy
	RouteAssignments    map[string]*relayv1.RoutePolicy
	Admission           *relayv1.AdmissionPolicy
	Digest              [sha256.Size]byte
}

type trustedPolicyKey struct {
	PublicKey   ed25519.PublicKey
	Fingerprint string
	ValidFrom   time.Time
	VerifyUntil time.Time
}

type persistedTrust struct {
	Keys []persistedTrustKey `json:"keys"`
}

type persistedTrustKey struct {
	KeyID       string `json:"keyId"`
	PublicKey   []byte `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
	ValidFrom   int64  `json:"validFrom,omitempty"`
	VerifyUntil int64  `json:"verifyUntil,omitempty"`
}

type Store struct {
	db          *bolt.DB
	mu          sync.RWMutex
	current     *Snapshot
	mode        relayv1.RelayMode
	poolID      string
	instanceID  string
	now         func() time.Time
	policyTrust map[string]trustedPolicyKey
}

func Open(dir string) (*Store, error) {
	return OpenWithOptions(dir, Options{Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED})
}

func OpenWithOptions(dir string, options Options) (*Store, error) {
	if options.Mode == relayv1.RelayMode_RELAY_MODE_UNSPECIFIED {
		options.Mode = relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED
	}
	if options.Mode == relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY && (options.PoolID == "" || options.InstanceID == "") {
		return nil, fmt.Errorf("remote relay pool and instance identity are required")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "relay.db"), 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	store := &Store{
		db: db, mode: options.Mode, poolID: options.PoolID, instanceID: options.InstanceID,
		now: options.Now, policyTrust: map[string]trustedPolicyKey{},
	}
	store.current = emptySnapshot(store.mode, store.poolID, store.instanceID)
	if err := db.Update(func(tx *bolt.Tx) error { _, err := tx.CreateBucketIfNotExists(bucketState); return err }); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.loadTrust(); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.load(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func emptySnapshot(mode relayv1.RelayMode, poolID, instanceID string) *Snapshot {
	return &Snapshot{
		Mode: mode, PoolID: poolID, RelayInstanceID: instanceID,
		PublicKeys: map[string]ed25519.PublicKey{}, Endpoints: map[string]*relayv1.EndpointPolicy{},
		Routes: map[string]*relayv1.RoutePolicy{}, EndpointAssignments: map[string]*relayv1.EndpointPolicy{},
		RouteAssignments: map[string]*relayv1.RoutePolicy{}, Admission: defaultAdmissionPolicy(),
	}
}

func assignmentKey(id string, generation uint64) string {
	return fmt.Sprintf("%s:%d", id, generation)
}

func (s *Snapshot) Endpoint(id string, assignmentGeneration uint64) *relayv1.EndpointPolicy {
	if assignmentGeneration > 0 {
		if endpoint := s.EndpointAssignments[assignmentKey(id, assignmentGeneration)]; endpoint != nil {
			return endpoint
		}
	}
	return s.Endpoints[id]
}

func (s *Snapshot) Route(id string, assignmentGeneration uint64) *relayv1.RoutePolicy {
	if assignmentGeneration > 0 {
		if route := s.RouteAssignments[assignmentKey(id, assignmentGeneration)]; route != nil {
			return route
		}
	}
	return s.Routes[id]
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

func (s *Store) PolicyKeyIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.policyTrust))
	for id := range s.policyTrust {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func PublicKeyFingerprint(publicKey ed25519.PublicKey) string {
	digest := sha256.Sum256(publicKey)
	return "sha256:" + hex.EncodeToString(digest[:])
}

// BootstrapPolicyTrust is deliberately not a general key-add operation. The
// first raw key and matching fingerprint arrive over the authenticated
// enrollment/control channel; subsequent keys require signed rotation.
func (s *Store) BootstrapPolicyTrust(keyID string, raw []byte, fingerprint string) (bool, error) {
	if keyID == "" || len(raw) != ed25519.PublicKeySize {
		return false, fmt.Errorf("policy signing key is invalid")
	}
	publicKey := append(ed25519.PublicKey(nil), raw...)
	if fingerprint == "" || PublicKeyFingerprint(publicKey) != fingerprint {
		return false, fmt.Errorf("policy signing key fingerprint does not match public key")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.policyTrust[keyID]; ok {
		if existing.Fingerprint != fingerprint || !bytes.Equal(existing.PublicKey, publicKey) {
			return false, fmt.Errorf("policy signing key conflicts with pinned key")
		}
		return true, nil
	}
	if len(s.policyTrust) != 0 {
		return false, fmt.Errorf("new policy signing keys require signed rotation")
	}
	s.policyTrust[keyID] = trustedPolicyKey{PublicKey: publicKey, Fingerprint: fingerprint}
	if err := s.db.Update(func(tx *bolt.Tx) error { return persistTrust(tx.Bucket(bucketState), s.policyTrust) }); err != nil {
		delete(s.policyTrust, keyID)
		return false, err
	}
	return false, nil
}

func (s *Store) Apply(request *relayv1.ApplySnapshotRequest) (*Snapshot, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	encoded, digest, next, nextTrust, err := s.normalizeLocked(request, false)
	if err != nil {
		return nil, false, err
	}
	current := s.current
	if current.GatewayInstanceID != "" && next.GatewayInstanceID != current.GatewayInstanceID {
		return nil, false, fmt.Errorf("snapshot gateway instance changed")
	}
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
		if err := bucket.Put(keyDigest, digest[:]); err != nil {
			return err
		}
		return persistTrust(bucket, nextTrust)
	}); err != nil {
		return nil, false, err
	}
	s.current = next
	s.policyTrust = nextTrust
	return next, false, nil
}

func (s *Store) AdmissionError(at time.Time) error {
	current := s.Current()
	if current.Revision == 0 {
		return fmt.Errorf("policy snapshot is required")
	}
	if !current.ExpiresAt.IsZero() && !at.Before(current.ExpiresAt) {
		return fmt.Errorf("policy snapshot expired")
	}
	return nil
}

func (s *Store) Ready(at time.Time) bool { return s.AdmissionError(at) == nil }

func (s *Store) loadTrust() error {
	return s.db.View(func(tx *bolt.Tx) error {
		value := tx.Bucket(bucketState).Get(keyPolicyTrust)
		if len(value) == 0 {
			return nil
		}
		var state persistedTrust
		if err := json.Unmarshal(value, &state); err != nil {
			return fmt.Errorf("decode policy trust: %w", err)
		}
		for _, record := range state.Keys {
			if record.KeyID == "" || len(record.PublicKey) != ed25519.PublicKeySize || PublicKeyFingerprint(record.PublicKey) != record.Fingerprint {
				return fmt.Errorf("persisted policy trust is invalid")
			}
			s.policyTrust[record.KeyID] = trustedPolicyKey{
				PublicKey: append(ed25519.PublicKey(nil), record.PublicKey...), Fingerprint: record.Fingerprint,
				ValidFrom: unixTime(record.ValidFrom), VerifyUntil: unixTime(record.VerifyUntil),
			}
		}
		return nil
	})
}

func persistTrust(bucket *bolt.Bucket, keys map[string]trustedPolicyKey) error {
	state := persistedTrust{Keys: make([]persistedTrustKey, 0, len(keys))}
	for keyID, key := range keys {
		state.Keys = append(state.Keys, persistedTrustKey{
			KeyID: keyID, PublicKey: key.PublicKey, Fingerprint: key.Fingerprint,
			ValidFrom: unixValue(key.ValidFrom), VerifyUntil: unixValue(key.VerifyUntil),
		})
	}
	sort.Slice(state.Keys, func(i, j int) bool { return state.Keys[i].KeyID < state.Keys[j].KeyID })
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return bucket.Put(keyPolicyTrust, encoded)
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
	_, _, snapshot, nextTrust, err := s.normalizeLocked(request, true)
	if err != nil {
		return fmt.Errorf("validate persisted snapshot: %w", err)
	}
	s.current = snapshot
	s.policyTrust = nextTrust
	return nil
}

func (s *Store) normalizeLocked(request *relayv1.ApplySnapshotRequest, allowExpired bool) ([]byte, [sha256.Size]byte, *Snapshot, map[string]trustedPolicyKey, error) {
	if request == nil {
		return nil, [sha256.Size]byte{}, nil, nil, fmt.Errorf("snapshot is required")
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(request)
	if err != nil {
		return nil, [sha256.Size]byte{}, nil, nil, err
	}
	digest := sha256.Sum256(encoded)
	if request.SignedEnvelope == nil {
		if s.mode != relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED {
			return nil, digest, nil, nil, fmt.Errorf("remote relay requires signed policy envelope")
		}
		next, err := normalizeLegacy(request, digest)
		return encoded, digest, next, cloneTrust(s.policyTrust), err
	}
	if len(s.policyTrust) == 0 {
		return nil, digest, nil, nil, fmt.Errorf("policy signing trust is not bootstrapped")
	}
	envelope := request.SignedEnvelope
	trusted, ok := s.policyTrust[envelope.SigningKeyId]
	if !ok || !trusted.validAt(s.now()) || len(envelope.Signature) != ed25519.SignatureSize || !ed25519.Verify(trusted.PublicKey, envelope.Payload, envelope.Signature) {
		return nil, digest, nil, nil, fmt.Errorf("policy envelope signature is invalid")
	}
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(envelope.Payload, payload); err != nil {
		return nil, digest, nil, nil, fmt.Errorf("decode policy envelope: %w", err)
	}
	next, nextTrust, err := s.normalizeSignedPayload(payload, digest, envelope.SigningKeyId, allowExpired)
	if err != nil {
		return nil, digest, nil, nil, err
	}
	return encoded, digest, next, nextTrust, nil
}

func normalizeLegacy(request *relayv1.ApplySnapshotRequest, digest [sha256.Size]byte) (*Snapshot, error) {
	if request.Revision == 0 || request.GatewayInstanceId == "" {
		return nil, fmt.Errorf("snapshot revision and gateway instance id are required")
	}
	return buildSnapshot(&relayv1.PolicyEnvelopePayload{
		SchemaVersion: 1, GatewayInstanceId: request.GatewayInstanceId, Revision: request.Revision,
		GrantPublicKeys: request.PublicKeys, Endpoints: request.Endpoints, Routes: request.Routes,
		AdmissionPolicy: request.AdmissionPolicy,
	}, relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED, digest)
}

func (s *Store) normalizeSignedPayload(payload *relayv1.PolicyEnvelopePayload, digest [sha256.Size]byte, signer string, allowExpired bool) (*Snapshot, map[string]trustedPolicyKey, error) {
	if payload.SchemaVersion != 2 || payload.GatewayInstanceId == "" || payload.PoolId == "" || payload.RelayInstanceId == "" || payload.Revision == 0 {
		return nil, nil, fmt.Errorf("policy envelope scope is invalid")
	}
	if payload.PoolId != s.poolID || payload.RelayInstanceId != s.instanceID {
		return nil, nil, fmt.Errorf("policy envelope targets another relay instance")
	}
	issuedAt, expiresAt := time.Unix(payload.IssuedAtUnix, 0), time.Unix(payload.ExpiresAtUnix, 0)
	now := s.now()
	if expiresAt.Sub(issuedAt) <= 0 || expiresAt.Sub(issuedAt) > PolicyLease {
		return nil, nil, fmt.Errorf("policy envelope lease is invalid")
	}
	if issuedAt.After(now.Add(IssuedAtClockSkew)) {
		return nil, nil, fmt.Errorf("policy envelope was issued in the future")
	}
	if !allowExpired && !now.Before(expiresAt) {
		return nil, nil, fmt.Errorf("policy envelope is expired")
	}
	if !contains(payload.Capabilities, PoolCapability) {
		return nil, nil, fmt.Errorf("policy envelope lacks relay pool capability")
	}
	nextTrust := make(map[string]trustedPolicyKey, len(payload.PolicySigningKeys))
	for _, key := range payload.PolicySigningKeys {
		if key.KeyId == "" || len(key.PublicKey) != ed25519.PublicKeySize || (key.Status != "active" && key.Status != "verification_only") {
			return nil, nil, fmt.Errorf("policy envelope contains invalid signing key")
		}
		publicKey := append(ed25519.PublicKey(nil), key.PublicKey...)
		if PublicKeyFingerprint(publicKey) != key.PublicKeyFingerprint {
			return nil, nil, fmt.Errorf("policy signing key fingerprint mismatch")
		}
		if _, exists := nextTrust[key.KeyId]; exists {
			return nil, nil, fmt.Errorf("duplicate policy signing key %q", key.KeyId)
		}
		nextTrust[key.KeyId] = trustedPolicyKey{
			PublicKey: publicKey, Fingerprint: key.PublicKeyFingerprint,
			ValidFrom: unixTime(key.ValidFromUnix), VerifyUntil: unixTime(key.VerifyUntilUnix),
		}
	}
	currentSigner, exists := nextTrust[signer]
	if !exists {
		return nil, nil, fmt.Errorf("policy envelope removes its signing key")
	}
	previousSigner := s.policyTrust[signer]
	if previousSigner.Fingerprint != currentSigner.Fingerprint || !bytes.Equal(previousSigner.PublicKey, currentSigner.PublicKey) {
		return nil, nil, fmt.Errorf("policy envelope changes its signing key material")
	}
	next, err := buildSnapshot(payload, s.mode, digest)
	if err != nil {
		return nil, nil, err
	}
	next.IssuedAt, next.ExpiresAt = issuedAt, expiresAt
	return next, nextTrust, nil
}

func buildSnapshot(payload *relayv1.PolicyEnvelopePayload, mode relayv1.RelayMode, digest [sha256.Size]byte) (*Snapshot, error) {
	next := &Snapshot{
		SchemaVersion: payload.SchemaVersion, Mode: mode, Revision: payload.Revision,
		GatewayInstanceID: payload.GatewayInstanceId, PoolID: payload.PoolId, RelayInstanceID: payload.RelayInstanceId,
		Capabilities: append([]string(nil), payload.Capabilities...), PublicKeys: map[string]ed25519.PublicKey{},
		Endpoints: map[string]*relayv1.EndpointPolicy{}, Routes: map[string]*relayv1.RoutePolicy{},
		EndpointAssignments: map[string]*relayv1.EndpointPolicy{}, RouteAssignments: map[string]*relayv1.RoutePolicy{},
		Admission: defaultAdmissionPolicy(), Digest: digest,
	}
	if payload.AdmissionPolicy != nil {
		next.Admission = proto.Clone(payload.AdmissionPolicy).(*relayv1.AdmissionPolicy)
	}
	if err := validateAdmissionPolicy(next.Admission); err != nil {
		return nil, err
	}
	for _, key := range payload.GrantPublicKeys {
		if key.KeyId == "" || len(key.PublicKey) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid public key")
		}
		if _, exists := next.PublicKeys[key.KeyId]; exists {
			return nil, fmt.Errorf("duplicate public key %q", key.KeyId)
		}
		next.PublicKeys[key.KeyId] = append(ed25519.PublicKey(nil), key.PublicKey...)
	}
	for _, endpoint := range payload.Endpoints {
		if endpoint.EndpointId == "" || endpoint.Generation == 0 || endpoint.SubjectKind == "" || endpoint.SubjectId == "" || endpoint.CertificateSha256 == "" {
			return nil, fmt.Errorf("invalid endpoint policy")
		}
		if payload.SchemaVersion == 2 && (endpoint.PoolId != payload.PoolId || endpoint.RelayInstanceId != payload.RelayInstanceId || endpoint.AssignmentGeneration == 0) {
			return nil, fmt.Errorf("endpoint policy relay assignment scope is invalid")
		}
		clone := proto.Clone(endpoint).(*relayv1.EndpointPolicy)
		if payload.SchemaVersion == 2 {
			key := assignmentKey(endpoint.EndpointId, endpoint.AssignmentGeneration)
			if _, exists := next.EndpointAssignments[key]; exists {
				return nil, fmt.Errorf("duplicate endpoint assignment %q", key)
			}
			next.EndpointAssignments[key] = clone
		} else if _, exists := next.Endpoints[endpoint.EndpointId]; exists {
			return nil, fmt.Errorf("duplicate endpoint %q", endpoint.EndpointId)
		}
		if current := next.Endpoints[endpoint.EndpointId]; current == nil || endpoint.AssignmentGeneration > current.AssignmentGeneration {
			next.Endpoints[endpoint.EndpointId] = clone
		}
	}
	for _, route := range payload.Routes {
		if route.RouteId == "" || route.Generation == 0 || route.SourceKind == "" || route.SourceId == "" || route.SourceCertificateSha256 == "" {
			return nil, fmt.Errorf("invalid route policy")
		}
		if payload.SchemaVersion == 2 && route.AssignmentGeneration == 0 {
			return nil, fmt.Errorf("route policy assignment generation is required")
		}
		if endpoint := next.Endpoint(route.TargetEndpointId, route.AssignmentGeneration); endpoint == nil {
			return nil, fmt.Errorf("route %q targets unknown endpoint", route.RouteId)
		} else if payload.SchemaVersion == 2 && route.AssignmentGeneration != endpoint.AssignmentGeneration {
			return nil, fmt.Errorf("route %q assignment generation does not match endpoint", route.RouteId)
		}
		clone := proto.Clone(route).(*relayv1.RoutePolicy)
		if payload.SchemaVersion == 2 {
			key := assignmentKey(route.RouteId, route.AssignmentGeneration)
			if _, exists := next.RouteAssignments[key]; exists {
				return nil, fmt.Errorf("duplicate route assignment %q", key)
			}
			next.RouteAssignments[key] = clone
		} else if _, exists := next.Routes[route.RouteId]; exists {
			return nil, fmt.Errorf("duplicate route %q", route.RouteId)
		}
		if current := next.Routes[route.RouteId]; current == nil || route.AssignmentGeneration > current.AssignmentGeneration {
			next.Routes[route.RouteId] = clone
		}
	}
	return next, nil
}

func (key trustedPolicyKey) validAt(at time.Time) bool {
	if !key.ValidFrom.IsZero() && at.Before(key.ValidFrom) {
		return false
	}
	return key.VerifyUntil.IsZero() || at.Before(key.VerifyUntil)
}

func cloneTrust(source map[string]trustedPolicyKey) map[string]trustedPolicyKey {
	next := make(map[string]trustedPolicyKey, len(source))
	for id, key := range source {
		key.PublicKey = append(ed25519.PublicKey(nil), key.PublicKey...)
		next[id] = key
	}
	return next
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func unixTime(value int64) time.Time {
	if value == 0 {
		return time.Time{}
	}
	return time.Unix(value, 0)
}

func unixValue(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.Unix()
}

func defaultAdmissionPolicy() *relayv1.AdmissionPolicy {
	return &relayv1.AdmissionPolicy{Enabled: true, ProxyTargetPressurePercent: 70, DatabaseReservePercent: 20, HardPressurePercent: 95}
}

func validateAdmissionPolicy(value *relayv1.AdmissionPolicy) error {
	if value == nil || !value.Enabled {
		return nil
	}
	if value.ProxyTargetPressurePercent < 50 || value.ProxyTargetPressurePercent > 85 {
		return fmt.Errorf("proxy target pressure must be between 50 and 85 percent")
	}
	if value.DatabaseReservePercent < 5 || value.DatabaseReservePercent > 35 {
		return fmt.Errorf("database reserve must be between 5 and 35 percent")
	}
	if value.HardPressurePercent < 90 || value.HardPressurePercent > 99 {
		return fmt.Errorf("hard pressure cutoff must be between 90 and 99 percent")
	}
	if value.ProxyTargetPressurePercent+value.DatabaseReservePercent >= value.HardPressurePercent {
		return fmt.Errorf("proxy target pressure plus database reserve must remain below the hard cutoff")
	}
	return nil
}

func RevisionBytes(revision uint64) []byte {
	value := make([]byte, 8)
	binary.BigEndian.PutUint64(value, revision)
	return value
}
