package builder

import (
	"strings"
	"testing"
)

func TestRuntimeConfigsPinContainerdRuncBoundary(t *testing.T) {
	config := DefaultRuntimeConfig(987)
	containerdConfig, err := config.RenderContainerdConfig()
	if err != nil {
		t.Fatal(err)
	}
	buildkitConfig, err := config.RenderBuildkitConfig()
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		`address = "/run/gateway-builder/containerd/containerd.sock"`,
		`disabled_plugins = ["io.containerd.cri.v1.runtime", "io.containerd.grpc.v1.cri"]`,
		`disable = true`,
		`disable_connections = true`,
	} {
		if !strings.Contains(containerdConfig, required) {
			t.Fatalf("containerd config missing %q:\n%s", required, containerdConfig)
		}
	}
	for _, required := range []string{
		`insecure-entitlements = []`,
		`nameservers = ["1.1.1.1", "8.8.8.8"]`,
		`address = ["unix:///run/gateway-builder/buildkit/buildkitd.sock"]`,
		`disabled = true`,
		`[worker.oci]`,
		`enabled = false`,
		`namespace = "gateway-builds"`,
		`networkMode = "cni"`,
		`max-parallelism = 16`,
		`gc = true`,
		`maxUsedSpace = "21474836480B"`,
		`defaultCgroupParent = "gateway-builds"`,
		`[registry."127.0.0.1:5443"]`,
		`http = false`,
		`ca = ["/var/lib/docker-daemon/registry-proxy/ca.pem"]`,
		`[frontend."gateway.v0"]`,
	} {
		if !strings.Contains(buildkitConfig, required) {
			t.Fatalf("BuildKit config missing %q:\n%s", required, buildkitConfig)
		}
	}
	for _, forbidden := range []string{"docker.sock", "network.host", "security.insecure", "noProcessSandbox = true", "runsc", "BinaryName"} {
		if strings.Contains(buildkitConfig, forbidden) || strings.Contains(containerdConfig, forbidden) {
			t.Fatalf("runtime config contains forbidden value %q", forbidden)
		}
	}
}

func TestRuntimeConfigRejectsSharedOrArbitrarySockets(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	config.ContainerdSocket = "/run/containerd/containerd.sock"
	if err := config.Validate(); err == nil {
		t.Fatal("expected shared host containerd socket to be rejected")
	}
	config = DefaultRuntimeConfig(0)
	config.BuildkitSocket = "/tmp/buildkitd.sock"
	if err := config.Validate(); err == nil {
		t.Fatal("expected BuildKit socket outside the managed runtime directory to be rejected")
	}
}

func TestRuntimeConfigRejectsExcessiveBuilderParallelism(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	config.MaxParallelism = 17
	if err := config.Validate(); err == nil || !strings.Contains(err.Error(), "between 1 and 16") {
		t.Fatalf("excessive builder parallelism was accepted: %v", err)
	}
}

func TestLoopbackOnlyCNIHasNoEgressPlugin(t *testing.T) {
	config := RenderLoopbackOnlyCNIConfig()
	if !strings.HasSuffix(DefaultCNIConfigPath, ".conflist") {
		t.Fatalf("BuildKit must parse the managed CNI plugin chain as a conflist: %s", DefaultCNIConfigPath)
	}
	if !strings.Contains(config, `"plugins": [`) {
		t.Fatalf("loopback CNI config is not a plugin list: %s", config)
	}
	if !strings.Contains(config, `"type": "loopback"`) {
		t.Fatalf("loopback plugin missing: %s", config)
	}
	for _, forbidden := range []string{"bridge", "host-local", "portmap", "firewall"} {
		if strings.Contains(config, forbidden) {
			t.Fatalf("CNI config contains egress-capable plugin %q: %s", forbidden, config)
		}
	}
}
