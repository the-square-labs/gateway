package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// A docker-daemon running without root cannot delete the socket directory a
// root daemon left to uid 65532 when the node switched modes. It runs this
// image once as uid 65532 with that directory mounted at cleanDirectoryMount
// and cleanDirectoryEnv set; the connector empties the directory and exits.
const (
	cleanDirectoryEnv   = "GATEWAY_CONNECTOR_CLEAN_DIR"
	cleanDirectoryMount = "/run/gateway-clean"
)

// emptyCleanDirectory removes every entry of the mounted directory. Any other
// path is refused, so the mode cannot be pointed at the connector's own files.
func emptyCleanDirectory(directory string) error {
	if filepath.Clean(directory) != cleanDirectoryMount {
		return fmt.Errorf("%s must be %s", cleanDirectoryEnv, cleanDirectoryMount)
	}
	entries, err := os.ReadDir(cleanDirectoryMount)
	if err != nil {
		return fmt.Errorf("read %s: %w", cleanDirectoryMount, err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(cleanDirectoryMount, entry.Name())); err != nil {
			return fmt.Errorf("remove %s: %w", entry.Name(), err)
		}
	}
	return nil
}
