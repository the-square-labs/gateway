package main

import (
	"strings"
	"testing"
)

func TestDockerDaemonSystemdUnitDoesNotHardRequireDocker(t *testing.T) {
	unit := dockerDaemonSystemdUnitForDockerUnit("snap.docker.dockerd.service")

	if strings.Contains(unit, "Requires=snap.docker.dockerd.service") {
		t.Fatalf("unit must not hard-require Docker service:\n%s", unit)
	}
	if !strings.Contains(unit, "After=network-online.target snap.docker.dockerd.service") {
		t.Fatalf("unit should still order after Docker service:\n%s", unit)
	}
	if !strings.Contains(unit, "Wants=network-online.target snap.docker.dockerd.service") {
		t.Fatalf("unit should still want Docker service:\n%s", unit)
	}
}

func TestBuilderSystemdUnitHasNoDockerDependency(t *testing.T) {
	unit := dockerDaemonSystemdUnitForMode("builder")
	if strings.Contains(unit, "docker.service") || strings.Contains(unit, "snap.docker") {
		t.Fatalf("builder unit must not depend on Docker Engine:\n%s", unit)
	}
	if !strings.Contains(unit, "After=network-online.target") || !strings.Contains(unit, "Wants=network-online.target") {
		t.Fatalf("builder unit must retain network ordering:\n%s", unit)
	}
}

func TestGatewayCertSHA256Pattern(t *testing.T) {
	valid := "sha256:0123456789abcdef0123456789abcdef0123456789ABCDEF0123456789ABCDEF"
	if !gatewayCertSHA256Pattern.MatchString(valid) {
		t.Fatal("expected valid sha256 fingerprint to match")
	}

	invalid := []string{
		"",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"sha256:abcd",
		"sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			if gatewayCertSHA256Pattern.MatchString(value) {
				t.Fatalf("expected %q not to match", value)
			}
		})
	}
}
