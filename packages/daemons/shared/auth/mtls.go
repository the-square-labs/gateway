package auth

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// stagedSuffix marks a fully written credential file that has not been
// renamed into place yet. A crash between the key and certificate renames
// leaves the new certificate here; LoadCredentials completes the swap.
const stagedSuffix = ".next"

// TLSManager manages mTLS credentials with hot-swap support.
type TLSManager struct {
	CACertPath     string
	ClientCertPath string
	ClientKeyPath  string

	mu   sync.RWMutex
	cert *tls.Certificate
}

func NewTLSManager(caCertPath, clientCertPath, clientKeyPath string) *TLSManager {
	return &TLSManager{
		CACertPath:     caCertPath,
		ClientCertPath: clientCertPath,
		ClientKeyPath:  clientKeyPath,
	}
}

// LoadCredentials loads the client certificate and key from disk.
func (t *TLSManager) LoadCredentials() error {
	cert, err := tls.LoadX509KeyPair(t.ClientCertPath, t.ClientKeyPath)
	if err != nil {
		recovered, recoverErr := recoverStagedClientCertificate(t.ClientCertPath, t.ClientKeyPath)
		if recoverErr != nil {
			return fmt.Errorf("load client cert: %w", err)
		}
		cert = recovered
	}
	t.mu.Lock()
	t.cert = &cert
	t.mu.Unlock()
	return nil
}

// GetClientCertificate is the callback for tls.Config.GetClientCertificate.
// This enables hot-swapping certs without reconnecting.
func (t *TLSManager) GetClientCertificate(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.cert == nil {
		return nil, fmt.Errorf("no client certificate loaded")
	}
	return t.cert, nil
}

// ClientTLSConfig builds a tls.Config for mTLS connections.
func (t *TLSManager) ClientTLSConfig() (*tls.Config, error) {
	caCert, err := os.ReadFile(t.CACertPath)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse CA certificate")
	}

	if err := t.LoadCredentials(); err != nil {
		return nil, err
	}

	return &tls.Config{
		RootCAs:              caPool,
		GetClientCertificate: t.GetClientCertificate,
	}, nil
}

// SaveCredentials writes CA cert, client cert, and key to disk.
func SaveCredentials(caCertPath, clientCertPath, clientKeyPath string, caCert, clientCert, clientKey []byte) error {
	for _, dir := range []string{
		caCertPath, clientCertPath, clientKeyPath,
	} {
		if err := os.MkdirAll(dirOf(dir), 0700); err != nil {
			return err
		}
	}

	// Validate that cert and key are non-empty to avoid writing broken credentials
	if len(clientCert) == 0 {
		return fmt.Errorf("client certificate is empty")
	}
	if len(clientKey) == 0 {
		return fmt.Errorf("client key is empty")
	}

	// Never replace a working pair with material that does not load.
	if _, err := tls.X509KeyPair(clientCert, clientKey); err != nil {
		return fmt.Errorf("client certificate and key do not form a valid pair: %w", err)
	}

	// Write every file completely and durably before touching the live
	// paths, then rename the key before the certificate. A crash at any
	// point leaves either the old pair, the new pair, or the new key with the
	// new certificate staged next to the old one, which LoadCredentials
	// recovers. Plain in-place writes could leave a torn or mismatched pair
	// and lock the node out.
	stagedKey := clientKeyPath + stagedSuffix
	stagedCert := clientCertPath + stagedSuffix
	if err := writeFileDurable(stagedKey, clientKey, 0600); err != nil {
		return fmt.Errorf("write client key: %w", err)
	}
	if err := writeFileDurable(stagedCert, clientCert, 0644); err != nil {
		_ = os.Remove(stagedKey)
		return fmt.Errorf("write client cert: %w", err)
	}
	if caCert != nil {
		if err := replaceFileAtomic(caCertPath, caCert, 0644); err != nil {
			_ = os.Remove(stagedKey)
			_ = os.Remove(stagedCert)
			return fmt.Errorf("write CA cert: %w", err)
		}
	}
	if err := os.Rename(stagedKey, clientKeyPath); err != nil {
		_ = os.Remove(stagedKey)
		_ = os.Remove(stagedCert)
		return fmt.Errorf("install client key: %w", err)
	}
	if err := os.Rename(stagedCert, clientCertPath); err != nil {
		return fmt.Errorf("install client cert: %w", err)
	}
	for _, dir := range uniqueDirs(clientKeyPath, clientCertPath) {
		if err := syncDir(dir); err != nil {
			return fmt.Errorf("sync credential directory: %w", err)
		}
	}
	return nil
}

// recoverStagedClientCertificate completes a credential swap interrupted
// after the new key was installed but before its certificate was.
func recoverStagedClientCertificate(clientCertPath, clientKeyPath string) (tls.Certificate, error) {
	stagedCert := clientCertPath + stagedSuffix
	cert, err := tls.LoadX509KeyPair(stagedCert, clientKeyPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.Rename(stagedCert, clientCertPath); err != nil {
		return tls.Certificate{}, err
	}
	_ = syncDir(filepath.Dir(clientCertPath))
	return cert, nil
}

func writeFileDurable(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func replaceFileAtomic(path string, data []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := writeFileDurable(temporary, data, mode); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

func uniqueDirs(paths ...string) []string {
	seen := make(map[string]struct{}, len(paths))
	dirs := make([]string, 0, len(paths))
	for _, path := range paths {
		dir := filepath.Dir(path)
		if _, ok := seen[dir]; ok {
			continue
		}
		seen[dir] = struct{}{}
		dirs = append(dirs, dir)
	}
	return dirs
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[:i]
		}
	}
	return "."
}
