package builder

import (
	"strconv"
	"strings"
	"testing"
)

func TestRuntimeUnitsExposeNoPublicListenerOrDockerDependency(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	containerdUnit := renderContainerdUnit(config)
	buildkitUnit := renderBuildkitUnit(config)
	for _, forbidden := range []string{"-H tcp://", "0.0.0.0", "docker.sock", "dockerd"} {
		if strings.Contains(containerdUnit, forbidden) || strings.Contains(buildkitUnit, forbidden) {
			t.Fatalf("runtime unit contains forbidden value %q", forbidden)
		}
	}
	for _, required := range []string{
		"containerd --config /etc/gateway-builder/containerd.toml",
		"buildkitd --config /etc/gateway-builder/buildkitd.toml",
		"Requires=gateway-builder-containerd.service",
		"NoNewPrivileges=true",
		"CPUQuota=200.00%",
		"MemoryMax=4294967296",
		"TasksMax=2048",
		"OOMPolicy=kill",
		"TimeoutStopSec=15s",
	} {
		if !strings.Contains(containerdUnit+buildkitUnit, required) {
			t.Fatalf("runtime units missing %q", required)
		}
	}
}

func TestRuntimeStartRestartsPinnedServicesAfterConfigurationUpdate(t *testing.T) {
	supervisor := NewRuntimeSupervisor(DefaultRuntimeConfig(0))
	var calls []string
	supervisor.lookPath = func(name string) (string, error) { return "/usr/bin/" + name, nil }
	supervisor.run = func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	}
	if err := supervisor.Start(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(calls, "\n")
	for _, required := range []string{
		"systemctl restart gateway-builder-egress.service",
		"systemctl enable gateway-builder-containerd.service",
		"systemctl enable gateway-builder-buildkit.service",
		"systemctl restart gateway-builder-containerd.service",
		"systemctl restart gateway-builder-buildkit.service",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("runtime start did not execute %q:\n%s", required, joined)
		}
	}
}

func TestGitAskpassUsesEnvironmentOnly(t *testing.T) {
	helper := renderGitAskpass()
	for _, required := range []string{"GATEWAY_GIT_USERNAME", "GATEWAY_GIT_PASSWORD"} {
		if !strings.Contains(helper, required) {
			t.Fatalf("askpass helper missing %q", required)
		}
	}
	for _, forbidden := range []string{"curl", "git config", "echo $"} {
		if strings.Contains(helper, forbidden) {
			t.Fatalf("askpass helper contains forbidden value %q", forbidden)
		}
	}
}

func TestControlPlaneAddressProducesExplicitDenyRule(t *testing.T) {
	for _, test := range []struct {
		address string
		host    string
		port    string
	}{
		{address: "gateway.example.com:9443", host: "gateway.example.com", port: "9443"},
		{address: "203.0.113.10:9555", host: "203.0.113.10", port: "9555"},
		{address: "[2001:db8::10]:9666", host: "2001:db8::10", port: "9666"},
	} {
		t.Run(test.address, func(t *testing.T) {
			host, port := splitControlPlaneAddress(test.address)
			if host != test.host || port != test.port {
				t.Fatalf("unexpected endpoint %q:%q", host, port)
			}
			script := renderEgressScript(RuntimeConfig{ControlPlaneAddress: test.address, EgressProfile: "internet"})
			if !strings.Contains(script, "CONTROL_HOST="+strconv.Quote(test.host)) || !strings.Contains(script, "CONTROL_PORT="+strconv.Quote(test.port)) {
				t.Fatalf("control-plane deny rule is missing: %s", script)
			}
		})
	}
}

func TestEgressPolicyRunsBeforeCNIPluginAcceptRules(t *testing.T) {
	script := renderEgressScript(RuntimeConfig{ControlPlaneAddress: "gateway.example.com:9443", EgressProfile: "internet"})
	for _, required := range []string{
		`$IPT -N CNI-ADMIN 2>/dev/null || true`,
		`$IPT -C CNI-ADMIN -s "$SUBNET" -j "$CHAIN" 2>/dev/null || $IPT -I CNI-ADMIN 1 -s "$SUBNET" -j "$CHAIN"`,
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("egress policy is not installed in the CNI administrator chain: %s", script)
		}
	}
}
