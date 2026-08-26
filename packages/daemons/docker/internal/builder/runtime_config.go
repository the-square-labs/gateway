package builder

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	DefaultBuildkitSocket      = "/run/gateway-builder/buildkit/buildkitd.sock"
	DefaultBuildkitStateDir    = "/var/lib/docker-daemon/builder/buildkit"
	DefaultContainerdSocket    = "/run/gateway-builder/containerd/containerd.sock"
	DefaultContainerdStateDir  = "/run/gateway-builder/containerd/state"
	DefaultContainerdRootDir   = "/var/lib/docker-daemon/builder/containerd"
	DefaultCNIConfigPath       = "/etc/gateway-builder/cni.conflist"
	DefaultCNIBinaryDir        = "/opt/gateway-builder/cni/bin"
	DefaultRegistryCAPath      = "/var/lib/docker-daemon/registry-proxy/ca.pem"
	DefaultContainerdNamespace = "gateway-builds"
	DefaultBuildParallelism    = 1
	DefaultCPULimitMillis      = int64(2000)
	DefaultMemoryLimitBytes    = int64(4 * 1024 * 1024 * 1024)
	DefaultDiskLimitBytes      = int64(20 * 1024 * 1024 * 1024)
	DefaultTasksLimit          = int64(2048)
	DefaultEgressProfile       = "internet"
	BuilderNetworkSubnet       = "10.203.0.0/24"
	buildkitSocketDirectory    = "/run/gateway-builder/buildkit"
	containerdSocketDirectory  = "/run/gateway-builder/containerd"
)

type RuntimeConfig struct {
	BuildkitSocket      string
	BuildkitStateDir    string
	ContainerdSocket    string
	ContainerdStateDir  string
	ContainerdRootDir   string
	CNIConfigPath       string
	CNIBinaryDir        string
	RegistryCAPath      string
	ContainerdNamespace string
	SocketGID           int
	MaxParallelism      int
	CPULimitMillis      int64
	MemoryLimitBytes    int64
	DiskLimitBytes      int64
	TasksLimit          int64
	EgressProfile       string
	ControlPlaneAddress string
}

func DefaultRuntimeConfig(socketGID int) RuntimeConfig {
	return RuntimeConfig{
		BuildkitSocket:      DefaultBuildkitSocket,
		BuildkitStateDir:    DefaultBuildkitStateDir,
		ContainerdSocket:    DefaultContainerdSocket,
		ContainerdStateDir:  DefaultContainerdStateDir,
		ContainerdRootDir:   DefaultContainerdRootDir,
		CNIConfigPath:       DefaultCNIConfigPath,
		CNIBinaryDir:        DefaultCNIBinaryDir,
		RegistryCAPath:      DefaultRegistryCAPath,
		ContainerdNamespace: DefaultContainerdNamespace,
		SocketGID:           socketGID,
		MaxParallelism:      DefaultBuildParallelism,
		CPULimitMillis:      DefaultCPULimitMillis,
		MemoryLimitBytes:    DefaultMemoryLimitBytes,
		DiskLimitBytes:      DefaultDiskLimitBytes,
		TasksLimit:          DefaultTasksLimit,
		EgressProfile:       DefaultEgressProfile,
	}
}

func (c RuntimeConfig) Validate() error {
	if !filepath.IsAbs(c.BuildkitSocket) || filepath.Clean(filepath.Dir(c.BuildkitSocket)) != buildkitSocketDirectory {
		return fmt.Errorf("BuildKit socket must be directly under %s", buildkitSocketDirectory)
	}
	if !filepath.IsAbs(c.ContainerdSocket) || filepath.Clean(filepath.Dir(c.ContainerdSocket)) != containerdSocketDirectory {
		return fmt.Errorf("containerd socket must be directly under %s", containerdSocketDirectory)
	}
	for name, value := range map[string]string{
		"BuildKit state directory":   c.BuildkitStateDir,
		"containerd state directory": c.ContainerdStateDir,
		"containerd root directory":  c.ContainerdRootDir,
		"CNI config path":            c.CNIConfigPath,
		"CNI binary directory":       c.CNIBinaryDir,
		"registry CA path":           c.RegistryCAPath,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return fmt.Errorf("%s must be a clean absolute path", name)
		}
	}
	if c.ContainerdNamespace != DefaultContainerdNamespace {
		return errors.New("containerd namespace must remain gateway-builds")
	}
	if c.SocketGID < 0 {
		return errors.New("socket GID cannot be negative")
	}
	if c.MaxParallelism != 1 {
		return errors.New("isolated builder runtime requires exactly one concurrent build")
	}
	if c.CPULimitMillis < 100 || c.CPULimitMillis > 64_000 {
		return errors.New("builder CPU limit must be between 100 and 64000 millicores")
	}
	if c.MemoryLimitBytes < 512*1024*1024 {
		return errors.New("builder memory limit must be at least 512 MiB")
	}
	if c.DiskLimitBytes < 1024*1024*1024 {
		return errors.New("builder disk limit must be at least 1 GiB")
	}
	if c.TasksLimit < 64 {
		return errors.New("builder task limit must be at least 64")
	}
	if c.EgressProfile != "internet" && c.EgressProfile != "offline" {
		return errors.New("builder egress profile must be internet or offline")
	}
	return nil
}

func (c RuntimeConfig) RenderContainerdConfig() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	quote := strconv.Quote
	return strings.Join([]string{
		"version = 3",
		"root = " + quote(c.ContainerdRootDir),
		"state = " + quote(c.ContainerdStateDir),
		"disabled_plugins = [\"io.containerd.cri.v1.runtime\", \"io.containerd.grpc.v1.cri\"]",
		"",
		"[grpc]",
		"  address = " + quote(c.ContainerdSocket),
		"  gid = " + strconv.Itoa(c.SocketGID),
		"",
		"[plugins.\"io.containerd.nri.v1.nri\"]",
		"  disable = true",
		"  disable_connections = true",
		"",
	}, "\n"), nil
}

func (c RuntimeConfig) RenderBuildkitConfig() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	quote := strconv.Quote
	return strings.Join([]string{
		"root = " + quote(c.BuildkitStateDir),
		"insecure-entitlements = []",
		"",
		"[log]",
		"  format = \"json\"",
		"  level = \"info\"",
		"",
		"[dns]",
		"  nameservers = [\"1.1.1.1\", \"8.8.8.8\"]",
		"",
		"[grpc]",
		"  address = [" + quote("unix://"+c.BuildkitSocket) + "]",
		"  gid = " + strconv.Itoa(c.SocketGID),
		"",
		"[cdi]",
		"  disabled = true",
		"",
		"[worker.oci]",
		"  enabled = false",
		"",
		"[worker.containerd]",
		"  enabled = true",
		"  address = " + quote(c.ContainerdSocket),
		"  namespace = " + quote(c.ContainerdNamespace),
		"  snapshotter = \"overlayfs\"",
		"  networkMode = \"cni\"",
		"  cniConfigPath = " + quote(c.CNIConfigPath),
		"  cniBinaryPath = " + quote(c.CNIBinaryDir),
		"  max-parallelism = " + strconv.Itoa(c.MaxParallelism),
		"  gc = true",
		"  reservedSpace = \"1GB\"",
		"  maxUsedSpace = " + quote(strconv.FormatInt(c.DiskLimitBytes, 10)+"B"),
		"  minFreeSpace = \"10GB\"",
		"  defaultCgroupParent = \"gateway-builds\"",
		"",
		"[registry.\"127.0.0.1:5443\"]",
		"  http = false",
		"  ca = [" + quote(c.RegistryCAPath) + "]",
		"",
		"[frontend.\"gateway.v0\"]",
		"  enabled = false",
		"",
	}, "\n"), nil
}

func RenderLoopbackOnlyCNIConfig() string {
	return `{
  "cniVersion": "1.0.0",
  "name": "gateway-builder-deny-egress",
  "plugins": [
    {"type": "loopback"}
  ]
}
`
}

func RenderInternetCNIConfig() string {
	return `{
  "cniVersion": "1.0.0",
  "name": "gateway-builder-internet",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "gateway-builds0",
      "isGateway": true,
      "ipMasq": true,
      "hairpinMode": false,
      "ipam": {
        "type": "host-local",
        "dataDir": "/var/lib/docker-daemon/builder/cni",
        "ranges": [[{"subnet": "10.203.0.0/24", "gateway": "10.203.0.1"}]],
        "routes": [{"dst": "0.0.0.0/0"}]
      },
      "dns": {"nameservers": ["1.1.1.1", "8.8.8.8"]}
    },
    {"type": "firewall", "backend": "iptables"}
  ]
}
`
}
