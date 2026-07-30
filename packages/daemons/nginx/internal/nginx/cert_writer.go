package nginx

import (
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
