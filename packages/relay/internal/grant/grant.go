package grant

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
)

const (
	Audience  = "wiolett-relay"
	MaxTTL    = 48 * time.Hour
	ClockSkew = 5 * time.Minute
)

type Claims struct {
	SchemaVersion         uint32 `json:"schemaVersion"`
	Audience              string `json:"audience"`
	GrantID               string `json:"grantId"`
	GatewayInstanceID     string `json:"gatewayInstanceId"`
	Kind                  string `json:"kind"`
	SubjectKind           string `json:"subjectKind"`
	SubjectID             string `json:"subjectId"`
	CertificateSHA256     string `json:"certificateSha256"`
	PoolID                string `json:"poolId,omitempty"`
	RelayInstanceID       string `json:"relayInstanceId,omitempty"`
	AssignmentGeneration  uint64 `json:"assignmentGeneration,omitempty"`
	EndpointID            string `json:"endpointId,omitempty"`
	EndpointGeneration    uint64 `json:"endpointGeneration,omitempty"`
	RouteID               string `json:"routeId,omitempty"`
	RouteGeneration       uint64 `json:"routeGeneration,omitempty"`
	IssuedAt              int64  `json:"issuedAt"`
	NotBefore             int64  `json:"notBefore"`
	ExpiresAt             int64  `json:"expiresAt"`
	MaxConcurrentSessions uint32 `json:"maxConcurrentSessions,omitempty"`
	MaxFrameBytes         uint32 `json:"maxFrameBytes,omitempty"`
}

type Verifier struct {
	Store *policy.Store
	Now   func() time.Time
}

func (v Verifier) Verify(envelope *relayv1.SignedGrant, wantKind string, identity peer.Identity) (Claims, error) {
	if envelope == nil || envelope.KeyId == "" || len(envelope.Payload) == 0 || len(envelope.Signature) != ed25519.SignatureSize {
		return Claims{}, fmt.Errorf("signed grant is incomplete")
	}
	snapshot := v.Store.Current()
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	if err := v.Store.AdmissionError(now); err != nil {
		return Claims{}, err
	}
	key, ok := snapshot.PublicKeys[envelope.KeyId]
	if !ok || !ed25519.Verify(key, envelope.Payload, envelope.Signature) {
		return Claims{}, fmt.Errorf("grant signature is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	var claims Claims
	if err := decoder.Decode(&claims); err != nil {
		return Claims{}, fmt.Errorf("grant payload is invalid: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Claims{}, fmt.Errorf("grant payload contains trailing data")
	}
	if (claims.SchemaVersion != 1 && claims.SchemaVersion != 2) || claims.Audience != Audience || claims.GrantID == "" || claims.GatewayInstanceID != snapshot.GatewayInstanceID {
		return Claims{}, fmt.Errorf("grant scope is invalid")
	}
	if claims.SchemaVersion == 1 && snapshot.Mode == relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY {
		return Claims{}, fmt.Errorf("remote relay rejects legacy grants")
	}
	if claims.SchemaVersion == 2 && (claims.PoolID != snapshot.PoolID || claims.RelayInstanceID != snapshot.RelayInstanceID || claims.AssignmentGeneration == 0) {
		return Claims{}, fmt.Errorf("grant relay assignment scope is invalid")
	}
	if claims.Kind != wantKind || claims.SubjectKind == "" || claims.CertificateSHA256 != identity.CertificateFingerprint {
		return Claims{}, fmt.Errorf("grant subject is invalid")
	}
	// Daemon certificates use their node ID as CN. Gateway service certificates
	// deliberately use a stable service CN, so their instance ID is bound by the
	// signed claims, policy snapshot and pinned certificate fingerprint instead.
	if claims.SubjectKind != "gateway" && claims.SubjectID != identity.SubjectID {
		return Claims{}, fmt.Errorf("grant subject is invalid")
	}
	issuedAt, notBefore, expiresAt := time.Unix(claims.IssuedAt, 0), time.Unix(claims.NotBefore, 0), time.Unix(claims.ExpiresAt, 0)
	if notBefore.Before(issuedAt) || !expiresAt.After(notBefore) || expiresAt.Sub(issuedAt) > MaxTTL {
		return Claims{}, fmt.Errorf("grant lifetime is invalid")
	}
	if now.Add(ClockSkew).Before(issuedAt) || now.Add(ClockSkew).Before(notBefore) || now.Add(-ClockSkew).After(expiresAt) {
		return Claims{}, fmt.Errorf("grant is not currently valid")
	}
	if err := ValidatePolicy(claims, wantKind, snapshot); err != nil {
		return Claims{}, err
	}
	return claims, nil
}

// ValidatePolicy binds already authenticated claims to one immutable policy
// snapshot. Broker admission calls it again while holding its own lock so a
// concurrent snapshot swap cannot retarget or resurrect a stale grant.
func ValidatePolicy(claims Claims, wantKind string, snapshot *policy.Snapshot) error {
	switch wantKind {
	case "endpoint":
		endpoint := snapshot.Endpoint(claims.EndpointID, claims.AssignmentGeneration)
		if endpoint == nil || endpoint.Generation != claims.EndpointGeneration || endpoint.SubjectKind != claims.SubjectKind || endpoint.SubjectId != claims.SubjectID || endpoint.CertificateSha256 != claims.CertificateSHA256 {
			return fmt.Errorf("endpoint grant does not match policy")
		}
		if claims.SchemaVersion == 2 && (endpoint.PoolId != claims.PoolID || endpoint.RelayInstanceId != claims.RelayInstanceID || endpoint.AssignmentGeneration != claims.AssignmentGeneration) {
			return fmt.Errorf("endpoint grant assignment does not match policy")
		}
	case "connect":
		route := snapshot.Route(claims.RouteID, claims.AssignmentGeneration)
		if route == nil || route.Generation != claims.RouteGeneration || route.SourceKind != claims.SubjectKind || route.SourceId != claims.SubjectID || route.SourceCertificateSha256 != claims.CertificateSHA256 {
			return fmt.Errorf("connect grant does not match policy")
		}
		if claims.SchemaVersion == 2 && route.AssignmentGeneration != claims.AssignmentGeneration {
			return fmt.Errorf("connect grant assignment does not match policy")
		}
	default:
		return fmt.Errorf("unsupported grant kind")
	}
	return nil
}
