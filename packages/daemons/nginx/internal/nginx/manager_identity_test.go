//go:build linux

package nginx

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEffectivePIDDirectiveAcceptsNginxWhitespaceAndQuotes(t *testing.T) {
	actual, err := effectivePIDDirective([]byte("# configuration file /etc/nginx/pid.conf:\n\tpid\t\"/run/nginx managed.pid\";\n"))
	if err != nil {
		t.Fatal(err)
	}
	if actual != "/run/nginx managed.pid" {
		t.Fatalf("effective pid path = %q", actual)
	}
}

func TestGetPIDRejectsReusedSameExecutablePIDThatIsNotNginxMaster(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := validateNginxMasterPID(os.Getpid(), filepath.Clean(executable)); err == nil {
		t.Fatal("same-executable non-master PID was accepted")
	}
}

func TestAuthoritativePidFileRejectsAmbiguousConfiguredDirectives(t *testing.T) {
	if _, err := effectivePIDDirective([]byte("pid /run/one.pid;\npid '/run/two.pid';\n")); err == nil {
		t.Fatal("ambiguous pid directives were accepted")
	}
}

func TestTrustedPIDFileRejectsWritableParent(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(directory, "nginx.pid")
	if err := os.WriteFile(pidPath, []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readTrustedPIDFile(pidPath); err == nil {
		t.Fatal("pid file below writable parent was accepted")
	}
}

func TestTrustedPIDOwnerRejectsAnotherUser(t *testing.T) {
	otherUID := uint32(os.Geteuid()) + 1
	if otherUID == 0 {
		otherUID++
	}
	if trustedPIDOwner(otherUID) {
		t.Fatal("attacker-owned pid file was accepted")
	}
}
