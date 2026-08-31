package nginx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigValidityCacheDoesNotSpawnNginx(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	failPath := filepath.Join(dir, "fail")
	binary := filepath.Join(dir, "nginx")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %q\n[ ! -f %q ]\n", argsPath, failPath)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(binary, dir, dir, "")
	if valid, _, checked := mgr.CachedConfigValidity(); valid || checked {
		t.Fatalf("unexpected initial cache state: valid=%v checked=%v", valid, checked)
	}
	if valid, _ := mgr.TestConfig(); !valid {
		t.Fatal("expected initial config test to pass")
	}
	if valid, checkedAt, checked := mgr.CachedConfigValidity(); !valid || !checked || checkedAt.IsZero() {
		t.Fatalf("unexpected cached success: valid=%v checked=%v checkedAt=%v", valid, checked, checkedAt)
	}
	before, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _ = mgr.CachedConfigValidity()
	after, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) || strings.Count(string(after), "-t") != 1 {
		t.Fatalf("cache read spawned nginx: %q", after)
	}

	if err := os.WriteFile(failPath, []byte("fail"), 0o600); err != nil {
		t.Fatal(err)
	}
	if valid, _ := mgr.TestConfig(); valid {
		t.Fatal("expected failed config test")
	}
	if valid, _, checked := mgr.CachedConfigValidity(); valid || !checked {
		t.Fatalf("unexpected cached failure: valid=%v checked=%v", valid, checked)
	}
}
