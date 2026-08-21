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
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(identity+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write host identity: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
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
