package lifecycle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

func loadOrCreateHostIdentity(path string) (string, error) {
	if path == "" {
		path = "/var/lib/gateway/host-identity"
	}
	if encoded, err := os.ReadFile(path); err == nil {
		identity := strings.TrimSpace(string(encoded))
		if _, parseErr := uuid.Parse(identity); parseErr != nil {
			return "", fmt.Errorf("invalid persisted host identity: %w", parseErr)
		}
		return identity, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read host identity: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create host identity directory: %w", err)
	}
	identity := uuid.NewString()
	file, err := os.CreateTemp(filepath.Dir(path), ".host-identity-*")
	if err != nil {
		return "", fmt.Errorf("create host identity: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.WriteString(identity + "\n"); err != nil {
		file.Close()
		return "", fmt.Errorf("write host identity: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close host identity: %w", err)
	}
	// Publish complete contents without replacing a concurrent daemon's identity.
	if err := os.Link(temporary, path); err != nil {
		if encoded, readErr := os.ReadFile(path); readErr == nil {
			existing := strings.TrimSpace(string(encoded))
			if _, parseErr := uuid.Parse(existing); parseErr == nil {
				return existing, nil
			}
		}
		return "", fmt.Errorf("persist host identity: %w", err)
	}
	return identity, nil
}
