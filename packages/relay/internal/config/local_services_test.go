package config

import "testing"

func TestBuiltinRegistryTargetIsImmutable(t *testing.T) {
	target, err := BuiltinLocalServiceTarget(RegistryServiceID)
	if err != nil {
		t.Fatal(err)
	}
	if target.Target != "registry:5000" {
		t.Fatalf("unexpected registry target %q", target.Target)
	}
	if _, err := BuiltinLocalServiceTarget("attacker-controlled"); err == nil {
		t.Fatal("expected unknown local service target to be rejected")
	}
}
