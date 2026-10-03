package main

import (
	"strings"
	"testing"
)

func TestCleanModeRefusesOtherDirectories(t *testing.T) {
	for _, directory := range []string{"/", "/run/gateway", "/run/gateway-clean/..", "relative"} {
		if err := emptyCleanDirectory(directory); err == nil || !strings.Contains(err.Error(), cleanDirectoryMount) {
			t.Fatalf("directory %q: error = %v, want a refusal", directory, err)
		}
	}
}
