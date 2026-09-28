package listenerkeep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureSystemdStoreInstallsTheDropInOnce(t *testing.T) {
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "run-systemd")
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cgroup := filepath.Join(root, "cgroup")
	if err := os.WriteFile(cgroup, []byte("0::/system.slice/nginx-daemon.service\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	unitDir := filepath.Join(root, "units")
	var calls []string
	storeMax := "0"
	systemctl := func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[0] == "show" {
			return storeMax, nil
		}
		return "", nil
	}

	installed, err := ensureSystemdStore(runtimeDir, cgroup, unitDir, systemctl)
	if err != nil || !installed {
		t.Fatalf("installed=%v err=%v", installed, err)
	}
	contents, err := os.ReadFile(filepath.Join(unitDir, "nginx-daemon.service.d", SystemdDropInName))
	if err != nil || !strings.Contains(string(contents), "FileDescriptorStoreMax=4096") || !strings.Contains(string(contents), "NotifyAccess=main") {
		t.Fatalf("drop-in = %q, %v", contents, err)
	}
	if calls[len(calls)-1] != "daemon-reload" {
		t.Fatalf("systemctl calls = %v", calls)
	}

	calls = nil
	if installed, err := ensureSystemdStore(runtimeDir, cgroup, unitDir, systemctl); err != nil || installed {
		t.Fatalf("second run installed=%v err=%v", installed, err)
	}
	for _, call := range calls {
		if call == "daemon-reload" {
			t.Fatal("an unchanged drop-in must not reload systemd")
		}
	}

	// A unit that already has a store, and a process outside systemd, are left alone.
	storeMax = "64"
	otherUnits := filepath.Join(root, "other-units")
	if installed, _ := ensureSystemdStore(runtimeDir, cgroup, otherUnits, systemctl); installed {
		t.Fatal("a unit with its own store got the drop-in")
	}
	if installed, _ := ensureSystemdStore(filepath.Join(root, "missing"), cgroup, otherUnits, systemctl); installed {
		t.Fatal("installed outside systemd")
	}
}

func TestSystemdUnitOfReadsTheServiceCgroup(t *testing.T) {
	for contents, want := range map[string]string{
		"0::/system.slice/nginx-daemon.service\n":                                                         "nginx-daemon.service",
		"12:pids:/system.slice/nginx-daemon.service\n1:name=systemd:/system.slice/nginx-daemon.service\n": "nginx-daemon.service",
		"0::/\n": "",
		"0::/user.slice/user-0.slice/user@0.service/app.slice/x.scope\n": "",
	} {
		path := filepath.Join(t.TempDir(), "cgroup")
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, err := systemdUnitOf(path); err != nil || got != want {
			t.Errorf("%q: unit = %q, %v; want %q", contents, got, err, want)
		}
	}
}
