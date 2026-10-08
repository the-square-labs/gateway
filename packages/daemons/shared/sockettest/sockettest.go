// Package sockettest gives tests directories for unix sockets.
//
// A unix socket path holds at most 107 bytes. t.TempDir() nests the test's
// name under TMPDIR, so a socket there fails to bind ("bind: invalid
// argument") once TMPDIR or the test name grows. Socket directories come from
// here instead.
package sockettest

import (
	"os"
	"testing"
)

// maxParent bounds the directory a socket directory is made in: sockets sit a
// few short directories and a name of up to ~45 bytes below it.
const maxParent = 24

// Dir is a new, empty directory for unix sockets whose paths stay within the
// limit however long TMPDIR and the test name are: in os.TempDir() when that
// is short, else in /tmp. It is removed when the test ends.
func Dir(t testing.TB) string {
	t.Helper()
	parent := os.TempDir()
	if len(parent) > maxParent {
		parent = "/tmp"
	}
	directory, err := os.MkdirTemp(parent, "gws")
	if err != nil {
		t.Fatalf("create a directory for unix sockets: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}
