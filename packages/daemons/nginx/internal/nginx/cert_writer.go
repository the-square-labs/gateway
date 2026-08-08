package nginx

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// DeployCert writes cert, key, and optional chain to the cert directory.
func DeployCert(certsDir, certID string, certPem, keyPem, chainPem []byte) error {
	dir := filepath.Join(certsDir, certID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}

	fullchainPem := certPem
	if len(chainPem) > 0 {
		fullchainPem = make([]byte, 0, len(certPem)+1+len(chainPem))
		fullchainPem = append(fullchainPem, certPem...)
		if len(certPem) > 0 && certPem[len(certPem)-1] != '\n' {
			fullchainPem = append(fullchainPem, '\n')
		}
		fullchainPem = append(fullchainPem, chainPem...)
	}

	if err := WriteAtomic(filepath.Join(dir, "fullchain.pem"), fullchainPem); err != nil {
		return fmt.Errorf("write cert: %w", err)
	}

	if err := WriteAtomic(filepath.Join(dir, "privkey.pem"), keyPem); err != nil {
		return fmt.Errorf("write key: %w", err)
	}

	// Set restrictive permissions on private key
	if err := os.Chmod(filepath.Join(dir, "privkey.pem"), 0600); err != nil {
		return fmt.Errorf("chmod key: %w", err)
	}

	if len(chainPem) > 0 {
		if err := WriteAtomic(filepath.Join(dir, "chain.pem"), chainPem); err != nil {
			return fmt.Errorf("write chain: %w", err)
		}
	}

	return nil
}

// RemoveCert removes a certificate directory.
func RemoveCert(certsDir, certID string) error {
	return RemoveDir(filepath.Join(certsDir, certID))
}

// CertPointer captures the current version symlink before a TLS bundle is
// activated. Keeping the pointer separate from the immutable version directory
// lets the command handler roll a failed nginx test back without rewriting key
// material.
type CertPointer struct {
	Exists                  bool
	Target                  string
	ReplicaGenerationExists bool
	ReplicaGeneration       string
}

type CertificateSnapshot struct {
	Present     bool
	Version     string
	Fingerprint string
}

// DeployVersionedCert stages a complete certificate/key pair under an
// immutable version directory and atomically switches <certID>/current.
// Existing legacy files remain untouched until a v2 config has been applied.
func DeployVersionedCert(certsDir, certID, version, replicaGeneration string, certPem, keyPem, chainPem []byte) (CertPointer, error) {
	previous, err := CurrentCertPointer(certsDir, certID)
	if err != nil {
		return CertPointer{}, err
	}

	root := filepath.Join(certsDir, certID)
	versionsDir := filepath.Join(root, "versions")
	versionDir := filepath.Join(versionsDir, version)
	if _, err := os.Stat(versionDir); err == nil {
		if err := switchCurrentPointer(root, version); err != nil {
			return CertPointer{}, err
		}
		if err := writeReplicaGeneration(root, replicaGeneration); err != nil {
			_ = RestoreCertPointer(certsDir, certID, previous)
			return CertPointer{}, err
		}
		return previous, nil
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("stat certificate version: %w", err)
	}

	if err := os.MkdirAll(versionsDir, 0755); err != nil {
		return CertPointer{}, fmt.Errorf("create versions dir: %w", err)
	}
	stage, err := os.MkdirTemp(root, ".certificate-stage-")
	if err != nil {
		return CertPointer{}, fmt.Errorf("create certificate stage: %w", err)
	}
	defer os.RemoveAll(stage)

	fullchainPem := certPem
	if len(chainPem) > 0 {
		fullchainPem = make([]byte, 0, len(certPem)+1+len(chainPem))
		fullchainPem = append(fullchainPem, certPem...)
		if len(certPem) > 0 && certPem[len(certPem)-1] != '\n' {
			fullchainPem = append(fullchainPem, '\n')
		}
		fullchainPem = append(fullchainPem, chainPem...)
	}
	if err := WriteAtomic(filepath.Join(stage, "fullchain.pem"), fullchainPem); err != nil {
		return CertPointer{}, fmt.Errorf("write staged certificate: %w", err)
	}
	if err := WriteAtomic(filepath.Join(stage, "privkey.pem"), keyPem); err != nil {
		return CertPointer{}, fmt.Errorf("write staged key: %w", err)
	}
	if err := os.Chmod(filepath.Join(stage, "privkey.pem"), 0600); err != nil {
		return CertPointer{}, fmt.Errorf("chmod staged key: %w", err)
	}
	if len(chainPem) > 0 {
		if err := WriteAtomic(filepath.Join(stage, "chain.pem"), chainPem); err != nil {
			return CertPointer{}, fmt.Errorf("write staged chain: %w", err)
		}
	}
	if err := WriteAtomic(filepath.Join(stage, ".gateway-version"), []byte(version)); err != nil {
		return CertPointer{}, fmt.Errorf("write certificate version: %w", err)
	}

	if err := os.Rename(stage, versionDir); err != nil {
		if !os.IsExist(err) {
			return CertPointer{}, fmt.Errorf("activate certificate version: %w", err)
		}
	}
	if err := switchCurrentPointer(root, version); err != nil {
		return CertPointer{}, err
	}
	if err := writeReplicaGeneration(root, replicaGeneration); err != nil {
		_ = RestoreCertPointer(certsDir, certID, previous)
		return CertPointer{}, err
	}
	return previous, nil
}

func CurrentCertPointer(certsDir, certID string) (CertPointer, error) {
	root := filepath.Join(certsDir, certID)
	pointer := CertPointer{}
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err == nil {
		pointer.Exists = true
		pointer.Target = target
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("read current certificate pointer: %w", err)
	}
	generation, err := os.ReadFile(filepath.Join(root, ".gateway-replica-generation"))
	if err == nil {
		pointer.ReplicaGenerationExists = true
		pointer.ReplicaGeneration = string(generation)
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("read certificate replica generation: %w", err)
	}
	return pointer, nil
}

func RestoreCertPointer(certsDir, certID string, pointer CertPointer) error {
	root := filepath.Join(certsDir, certID)
	current := filepath.Join(root, "current")
	if !pointer.Exists {
		if err := os.Remove(current); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove current certificate pointer: %w", err)
		}
	} else if err := switchCurrentPointerTarget(root, pointer.Target); err != nil {
		return err
	}
	generationPath := filepath.Join(root, ".gateway-replica-generation")
	if !pointer.ReplicaGenerationExists {
		if err := os.Remove(generationPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove certificate replica generation: %w", err)
		}
		return nil
	}
	if err := WriteAtomic(generationPath, []byte(pointer.ReplicaGeneration)); err != nil {
		return fmt.Errorf("restore certificate replica generation: %w", err)
	}
	return nil
}

func writeReplicaGeneration(root, generation string) error {
	if err := WriteAtomic(filepath.Join(root, ".gateway-replica-generation"), []byte(generation)); err != nil {
		return fmt.Errorf("write certificate replica generation: %w", err)
	}
	return nil
}

func switchCurrentPointer(root, version string) error {
	return switchCurrentPointerTarget(root, filepath.Join("versions", version))
}

func switchCurrentPointerTarget(root, target string) error {
	if err := os.MkdirAll(root, 0755); err != nil {
		return fmt.Errorf("create certificate root: %w", err)
	}
	tmp := filepath.Join(root, ".current.tmp")
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("clear temporary certificate pointer: %w", err)
	}
	if err := os.Symlink(target, tmp); err != nil {
		return fmt.Errorf("create temporary certificate pointer: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(root, "current")); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("switch certificate pointer: %w", err)
	}
	return nil
}

// InspectCertificate returns a non-secret fingerprint of the complete current
// pair. The key itself never leaves this package through the inventory path.
func InspectCertificate(certsDir, certID string) (CertificateSnapshot, error) {
	root := filepath.Join(certsDir, certID)
	base := root
	if pointer, err := CurrentCertPointer(certsDir, certID); err != nil {
		return CertificateSnapshot{}, err
	} else if pointer.Exists {
		base = filepath.Join(root, "current")
	}
	certPem, err := os.ReadFile(filepath.Join(base, "fullchain.pem"))
	if os.IsNotExist(err) {
		return CertificateSnapshot{Present: false}, nil
	}
	if err != nil {
		return CertificateSnapshot{}, fmt.Errorf("read certificate: %w", err)
	}
	keyPem, err := os.ReadFile(filepath.Join(base, "privkey.pem"))
	if err != nil {
		return CertificateSnapshot{}, fmt.Errorf("read certificate key: %w", err)
	}
	chainPem, err := os.ReadFile(filepath.Join(base, "chain.pem"))
	if err != nil && !os.IsNotExist(err) {
		return CertificateSnapshot{}, fmt.Errorf("read certificate chain: %w", err)
	}
	versionRaw, err := os.ReadFile(filepath.Join(base, ".gateway-version"))
	if err != nil && !os.IsNotExist(err) {
		return CertificateSnapshot{}, fmt.Errorf("read certificate version: %w", err)
	}
	hash := sha256.New()
	hash.Write(certPem)
	hash.Write([]byte{0})
	hash.Write(keyPem)
	hash.Write([]byte{0})
	hash.Write(chainPem)
	return CertificateSnapshot{
		Present:     true,
		Version:     string(versionRaw),
		Fingerprint: hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

// ReadCertificateForExport supports the one-time legacy migration command.
// It accepts only a cert ID the handler already validated and never lists a
// directory or otherwise exposes arbitrary daemon files.
func ReadCertificateForExport(certsDir, certID string) (certPem, keyPem, chainPem []byte, err error) {
	root := filepath.Join(certsDir, certID)
	base := root
	if pointer, pointerErr := CurrentCertPointer(certsDir, certID); pointerErr != nil {
		return nil, nil, nil, pointerErr
	} else if pointer.Exists {
		base = filepath.Join(root, "current")
	}
	certPem, err = os.ReadFile(filepath.Join(base, "fullchain.pem"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate: %w", err)
	}
	keyPem, err = os.ReadFile(filepath.Join(base, "privkey.pem"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate key: %w", err)
	}
	chainPem, err = os.ReadFile(filepath.Join(base, "chain.pem"))
	if os.IsNotExist(err) {
		return certPem, keyPem, nil, nil
	}
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate chain: %w", err)
	}
	// Legacy DeployCert wrote fullchain.pem as leaf + chain and retained a
	// separate chain.pem. Export the original leaf when this known layout is
	// present so Gateway does not append the chain twice when it builds v2.
	if leaf := bytes.TrimSuffix(certPem, chainPem); len(leaf) != len(certPem) {
		certPem = bytes.TrimSuffix(leaf, []byte("\n"))
	}
	return certPem, keyPem, chainPem, nil
}

func RemoveCertificateReplica(certsDir, certID, expectedVersion, expectedReplicaGeneration string) error {
	pointer, err := CurrentCertPointer(certsDir, certID)
	if err != nil {
		return err
	}
	if expectedVersion != "" {
		snapshot, err := InspectCertificate(certsDir, certID)
		if err != nil {
			return err
		}
		if snapshot.Present && snapshot.Version != expectedVersion {
			return fmt.Errorf("certificate replica generation changed")
		}
	}
	if expectedReplicaGeneration != "" && (!pointer.ReplicaGenerationExists || pointer.ReplicaGeneration != expectedReplicaGeneration) {
		return fmt.Errorf("certificate replica generation changed")
	}
	return RemoveCert(certsDir, certID)
}
