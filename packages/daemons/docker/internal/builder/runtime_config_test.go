package builder

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeConfigsPinContainerdRunscBoundary(t *testing.T) {
	config := DefaultRuntimeConfig(987)
	containerdConfig, err := config.RenderContainerdConfig()
	if err != nil {
		t.Fatal(err)
	}
	buildkitConfig, err := config.RenderBuildkitConfig()
	if err != nil {
		t.Fatal(err)
	}
	runscWrapper, err := config.RenderRunscWrapper()
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
		`max-parallelism = 1`,
		`gc = true`,
		`maxUsedSpace = "21474836480B"`,
		`defaultCgroupParent = "gateway-builds"`,
		`name = "io.containerd.runc.v2"`,
		`BinaryName = "/usr/local/lib/gateway-builder/runsc-oci"`,
		`[registry."127.0.0.1:5443"]`,
		`http = false`,
		`ca = ["/var/lib/docker-daemon/registry-proxy/ca.pem"]`,
		`[frontend."gateway.v0"]`,
	} {
		if !strings.Contains(buildkitConfig, required) {
			t.Fatalf("BuildKit config missing %q:\n%s", required, buildkitConfig)
		}
	}
	for _, required := range []string{
		`RUNSC='/usr/local/bin/runsc'`,
		`--network=host`,
		`--overlay2=none`,
		`--host-uds=none`,
		`--allow-packet-socket-write=false`,
		`--net-raw=false`,
		`grep -Fqx "sandbox is not running"`,
	} {
		if !strings.Contains(runscWrapper, required) {
			t.Fatalf("runsc wrapper missing %q:\n%s", required, runscWrapper)
		}
	}
	for _, forbidden := range []string{"docker.sock", "network.host", "security.insecure", "noProcessSandbox = true"} {
		if strings.Contains(buildkitConfig, forbidden) || strings.Contains(containerdConfig, forbidden) || strings.Contains(runscWrapper, forbidden) {
			t.Fatalf("runtime config contains forbidden value %q", forbidden)
		}
	}
}

func TestRunscWrapperOnlyNormalizesStoppedSandboxKill(t *testing.T) {
	directory := t.TempDir()
	fakeRunsc := filepath.Join(directory, "runsc")
	if err := os.WriteFile(fakeRunsc, []byte(`#!/bin/sh
case "$*" in
  *" kill "*) printf '%s\n' "${RUNSC_TEST_ERROR:-sandbox is not running}" >&2; exit 128 ;;
  *) printf '%s\n' "$*" ;;
esac
`), 0o755); err != nil {
		t.Fatal(err)
	}
	config := DefaultRuntimeConfig(0)
	config.RunscBinaryPath = fakeRunsc
	wrapper, err := config.RenderRunscWrapper()
	if err != nil {
		t.Fatal(err)
	}
	wrapper = strings.ReplaceAll(wrapper, "/run/gateway-builder/runsc-kill.", filepath.Join(directory, "runsc-kill."))
	wrapperPath := filepath.Join(directory, "runsc-oci")
	if err := os.WriteFile(wrapperPath, []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(wrapperPath, "--root=/tmp/runsc", "kill", "--all", "id", "9").CombinedOutput(); err != nil {
		t.Fatalf("stopped sandbox kill was not normalized: %v: %s", err, output)
	}
	command := exec.Command(wrapperPath, "--root=/tmp/runsc", "kill", "--all", "id", "9")
	command.Env = append(os.Environ(), "RUNSC_TEST_ERROR=permission denied")
	if output, err := command.CombinedOutput(); err == nil || !strings.Contains(string(output), "permission denied") {
		t.Fatalf("unrelated kill failure was hidden: %v: %s", err, output)
	}
	if output, err := exec.Command(wrapperPath, "create", "id").CombinedOutput(); err != nil || !strings.Contains(string(output), "--network=host") {
		t.Fatalf("non-kill invocation was not forwarded with hardening flags: %v: %s", err, output)
	}
}

func TestOfflineRunscWrapperDisablesNetworking(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	config.EgressProfile = "offline"
	wrapper, err := config.RenderRunscWrapper()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(wrapper, "--network=none") || strings.Contains(wrapper, "--network=host") {
		t.Fatalf("offline runsc wrapper did not disable networking:\n%s", wrapper)
	}
}

func TestRunscWrapperRemovesBuildKitOTELMountpointAfterDelete(t *testing.T) {
	directory := t.TempDir()
	fakeRunsc := filepath.Join(directory, "runsc")
	if err := os.WriteFile(fakeRunsc, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := DefaultRuntimeConfig(0)
	config.RunscBinaryPath = fakeRunsc
	config.ContainerdStateDir = filepath.Join(directory, "state")
	containerID := "buildkit-task-1"
	mountpoint := filepath.Join(
		config.ContainerdStateDir,
		"io.containerd.runtime.v2.task",
		config.ContainerdNamespace,
		containerID,
		"rootfs",
		"dev",
		"otel-grpc.sock",
	)
	if err := os.MkdirAll(filepath.Dir(mountpoint), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mountpoint, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	wrapper, err := config.RenderRunscWrapper()
	if err != nil {
		t.Fatal(err)
	}
	wrapper = strings.ReplaceAll(wrapper, "/run/gateway-builder/runsc-kill.", filepath.Join(directory, "runsc-kill."))
	wrapperPath := filepath.Join(directory, "runsc-oci")
	if err := os.WriteFile(wrapperPath, []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(wrapperPath, "--root=/tmp/runsc", "delete", "--force", containerID).CombinedOutput(); err != nil {
		t.Fatalf("delete invocation failed: %v: %s", err, output)
	}
	if _, err := os.Stat(mountpoint); !os.IsNotExist(err) {
		t.Fatalf("BuildKit OTEL mountpoint was not removed: %v", err)
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

func TestRuntimeConfigRejectsParallelUntrustedBuilds(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	config.MaxParallelism = 2
	if err := config.Validate(); err == nil || !strings.Contains(err.Error(), "exactly one concurrent build") {
		t.Fatalf("parallel builder profile was accepted: %v", err)
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
