package install

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/enrollment"
	"github.com/wiolett-industries/gateway/installer/internal/config"
)

type NodeInstaller struct {
	stdout io.Writer
	stderr io.Writer
	exec   Executor
	client *http.Client
}

func NewNode(stdout, stderr io.Writer) *NodeInstaller {
	return &NodeInstaller{stdout: stdout, stderr: stderr, exec: systemExecutor{stdout: stdout, stderr: stderr}, client: &http.Client{Timeout: 60 * time.Second}}
}

func (i *NodeInstaller) Run(ctx context.Context, node config.Node) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("node installation must run as root (or with sudo)")
	}
	if err := node.Normalize(); err != nil {
		return err
	}
	if err := node.ValidateEnrollment(); err != nil {
		return err
	}
	reportStep(i.stdout, "Validating enrollment token with Gateway")
	validatedType, err := enrollment.ValidateEnrollment(node.Gateway, node.Token, node.GatewayCertSHA256, string(node.Type))
	if err != nil {
		return fmt.Errorf("validate enrollment before installation: %w", err)
	}
	if validatedType != string(node.Type) {
		return fmt.Errorf("Gateway validated a %s token, but this installer is configuring a %s node", validatedType, node.Type)
	}
	fmt.Fprintln(i.stdout, "Enrollment token accepted.")
	if node.Type == config.NodeDatabases {
		reportStep(i.stdout, "Preparing database storage")
		if err := validateStorageRoot(node.DatabaseStorageRoot); err != nil {
			return err
		}
		if err := i.databasePreflight(ctx, node.DatabaseStorageRoot); err != nil {
			return err
		}
	}
	if node.Type == config.NodeDocker || node.Type == config.NodeDatabases {
		reportStep(i.stdout, "Checking Docker Engine")
		if err := i.ensureDocker(ctx); err != nil {
			return err
		}
	}
	if node.Type == config.NodeNginx && !node.SkipNginx {
		reportStep(i.stdout, "Checking Nginx")
		if err := i.ensureNginx(ctx, node.NginxRepository); err != nil {
			return err
		}
	}
	name, _, err := daemonRelease(node)
	if err != nil {
		return err
	}
	reportStep(i.stdout, "Resolving node daemon release")
	tag, err := resolveDaemonTag(i.client, node)
	if err != nil {
		return err
	}
	arch, err := linuxArch()
	if err != nil {
		return err
	}
	asset := name + "-linux-" + arch
	project := strings.ReplaceAll(node.GitLabProject, "/", "%2F")
	base := strings.TrimRight(node.GitLabURL, "/") + "/api/v4/projects/" + project + "/releases/" + tag + "/downloads"
	target := filepath.Join("/usr/local/bin", name)
	if err := backupIfChanged(target, node.Version); err != nil {
		return err
	}
	reportStep(i.stdout, "Downloading and verifying node daemon")
	if err := downloadAndVerify(i.client, base, asset, target, i.stdout); err != nil {
		return err
	}
	reportStep(i.stdout, "Enrolling node with Gateway")
	if err := i.enroll(ctx, node, target); err != nil {
		return err
	}
	if node.Type == config.NodeDatabases {
		if err := writeDatabaseProfile("/etc/docker-daemon/config.yaml", node.DatabaseStorageRoot); err != nil {
			return err
		}
	}
	reportStep(i.stdout, "Starting node service")
	if err := i.writeService(ctx, node, name); err != nil {
		return err
	}
	fmt.Fprintf(i.stdout, "\n%s node setup complete.\n", title(node.Type))
	return nil
}

func title(t config.NodeType) string {
	if t == config.NodeDatabases {
		return "Database"
	}
	return strings.ToUpper(string(t[:1])) + string(t[1:])
}

func (i *NodeInstaller) enroll(ctx context.Context, node config.Node, binary string) error {
	certDir, state := daemonPaths(node.Type)
	if _, err := os.Stat(filepath.Join(certDir, "node.pem")); err == nil {
		if _, err := os.Stat(state); err == nil {
			fmt.Fprintln(i.stdout, "Existing enrollment detected; keeping current certificate.")
			return nil
		}
	}
	args := []string{"install", "--gateway", node.Gateway, "--token", node.Token, "--gateway-cert-sha256", node.GatewayCertSHA256}
	if node.Type == config.NodeDocker || node.Type == config.NodeDatabases {
		args = append(args, "--docker-socket", "unix:///var/run/docker.sock")
	}
	return i.exec.Run(ctx, binary, args...)
}

func daemonPaths(t config.NodeType) (string, string) {
	name := string(t) + "-daemon"
	if t == config.NodeDatabases {
		name = "docker-daemon"
	}
	return "/etc/" + name + "/certs", "/var/lib/" + name + "/state.json"
}

func backupIfChanged(target, version string) error {
	if _, err := os.Stat(target); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	if version == "latest" {
		return nil
	}
	backup := target + ".backup." + time.Now().UTC().Format("20060102_150405")
	input, err := os.Open(target)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(backup, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (i *NodeInstaller) ensureDocker(ctx context.Context) error {
	_, dockerErr := exec.LookPath("docker")
	if dockerErr != nil || !dockerComposeAvailable(ctx) {
		reportStep(i.stdout, "Installing Docker Engine from Docker's official repository")
		if err := i.installDockerFromOfficialRepository(ctx); err != nil {
			return fmt.Errorf("install Docker Engine: %w", err)
		}
	}
	if err := i.ensureDockerService(ctx); err != nil {
		return err
	}
	if !dockerComposeAvailable(ctx) {
		return fmt.Errorf("Docker Compose plugin is unavailable after Docker installation")
	}
	return nil
}

func dockerComposeAvailable(ctx context.Context) bool {
	return exec.CommandContext(ctx, "docker", "compose", "version").Run() == nil
}

func dockerInfoAvailable(ctx context.Context) bool {
	return exec.CommandContext(ctx, "docker", "info").Run() == nil
}

func (i *NodeInstaller) installDockerFromOfficialRepository(ctx context.Context) error {
	distro, codename, err := dockerAptDistribution()
	if err != nil {
		return err
	}
	if err := i.installPackages(ctx, "ca-certificates", "curl"); err != nil {
		return fmt.Errorf("install Docker repository prerequisites: %w", err)
	}
	reportStep(i.stdout, "Adding Docker package repository")
	if err := i.exec.Run(ctx, "install", "-m", "0755", "-d", "/etc/apt/keyrings"); err != nil {
		return err
	}
	keyPath := "/etc/apt/keyrings/docker.asc"
	if err := i.exec.Run(ctx, "curl", "-fsSL", "https://download.docker.com/linux/"+distro+"/gpg", "-o", keyPath); err != nil {
		return fmt.Errorf("download Docker signing key: %w", err)
	}
	if err := i.exec.Run(ctx, "chmod", "a+r", keyPath); err != nil {
		return err
	}
	contents := fmt.Sprintf("Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s\n", distro, codename, dockerAptArchitecture(), keyPath)
	if err := os.WriteFile("/etc/apt/sources.list.d/docker.sources", []byte(contents), 0644); err != nil {
		return fmt.Errorf("write Docker apt source: %w", err)
	}
	if err := i.exec.Run(ctx, "apt-get", "update", "-qq"); err != nil {
		return err
	}
	reportStep(i.stdout, "Installing Docker Engine packages")
	return i.exec.Run(ctx, "apt-get", "install", "-y", "-qq", "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin")
}

func dockerAptDistribution() (string, string, error) {
	contents, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "", "", fmt.Errorf("read /etc/os-release for Docker repository: %w", err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(contents), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(value, "\"")
	}
	distro := values["ID"]
	if distro != "ubuntu" && distro != "debian" {
		return "", "", fmt.Errorf("automatic Docker installation is supported on Ubuntu and Debian only; install Docker Engine from https://docs.docker.com/engine/install/")
	}
	codename := values["VERSION_CODENAME"]
	if codename == "" {
		codename = values["UBUNTU_CODENAME"]
	}
	if codename == "" {
		return "", "", fmt.Errorf("could not determine the OS codename for Docker's apt repository")
	}
	return distro, codename, nil
}

func dockerAptArchitecture() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}

func (i *NodeInstaller) ensureDockerService(ctx context.Context) error {
	if dockerInfoAvailable(ctx) {
		return nil
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		reportStep(i.stdout, "Starting Docker service")
		if err := i.exec.Run(ctx, "systemctl", "enable", "--now", "docker"); err != nil {
			return fmt.Errorf("start Docker service: %w", err)
		}
	}
	if !dockerInfoAvailable(ctx) {
		return fmt.Errorf("Docker Engine is installed but the daemon is not running")
	}
	return nil
}

func (i *NodeInstaller) ensureNginx(ctx context.Context, _ string) error {
	if _, err := exec.LookPath("nginx"); err == nil {
		return nil
	}
	if err := i.installPackages(ctx, "nginx"); err != nil {
		return fmt.Errorf("install nginx: %w", err)
	}
	return nil
}

func (i *NodeInstaller) installPackages(ctx context.Context, packages ...string) error {
	if _, err := exec.LookPath("apt-get"); err == nil {
		if err := i.exec.Run(ctx, "apt-get", "update", "-qq"); err != nil {
			return err
		}
		return i.exec.Run(ctx, "apt-get", append([]string{"install", "-y", "-qq"}, packages...)...)
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		return i.exec.Run(ctx, "dnf", append([]string{"install", "-y"}, packages...)...)
	}
	if _, err := exec.LookPath("yum"); err == nil {
		return i.exec.Run(ctx, "yum", append([]string{"install", "-y"}, packages...)...)
	}
	if _, err := exec.LookPath("apk"); err == nil {
		return i.exec.Run(ctx, "apk", append([]string{"add"}, packages...)...)
	}
	return fmt.Errorf("unsupported package manager")
}

func (i *NodeInstaller) databasePreflight(ctx context.Context, root string) error {
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(root, ".gateway-db-preflight.")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	image, mount := filepath.Join(temporary, "test.img"), filepath.Join(temporary, "mnt")
	if err := os.Mkdir(mount, 0700); err != nil {
		return err
	}
	if err := i.exec.Run(ctx, "dd", "if=/dev/zero", "of="+image, "bs=1M", "count=16", "conv=fsync", "status=none"); err != nil {
		return fmt.Errorf("database storage preflight: %w", err)
	}
	if err := i.exec.Run(ctx, "mkfs.ext4", "-q", "-F", image); err != nil {
		return fmt.Errorf("database storage preflight: %w", err)
	}
	loop, err := exec.CommandContext(ctx, "losetup", "--find", "--show", image).Output()
	if err != nil {
		return fmt.Errorf("database storage preflight: create loop device: %w", err)
	}
	device := strings.TrimSpace(string(loop))
	defer exec.Command("losetup", "-d", device).Run()
	if err := i.exec.Run(ctx, "mount", device, mount); err != nil {
		return fmt.Errorf("database storage preflight: mount image: %w", err)
	}
	defer exec.Command("umount", mount).Run()
	if err := os.WriteFile(filepath.Join(mount, ".gateway-write-test"), []byte("ok\n"), 0600); err != nil {
		return fmt.Errorf("database storage preflight: write image: %w", err)
	}
	if err := i.exec.Run(ctx, "fallocate", "-l", "32M", image); err != nil {
		return fmt.Errorf("database storage preflight: grow image: %w", err)
	}
	if err := i.exec.Run(ctx, "losetup", "-c", device); err != nil {
		return fmt.Errorf("database storage preflight: refresh loop: %w", err)
	}
	if err := i.exec.Run(ctx, "resize2fs", device); err != nil {
		return fmt.Errorf("database storage preflight: grow filesystem: %w", err)
	}
	return nil
}

func validateStorageRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) == "/" {
		return fmt.Errorf("--storage-root must be an absolute non-root path")
	}
	if info, err := os.Lstat(root); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing symlink storage root: %s", root)
	}
	return nil
}

func writeDatabaseProfile(path, root string) error {
	contents, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read docker daemon config: %w", err)
	}
	text := string(contents)
	if !strings.Contains(text, "\ndocker:") && !strings.HasPrefix(text, "docker:") {
		return fmt.Errorf("docker daemon config has no docker section")
	}
	if strings.Contains(text, "\n  mode:") || strings.Contains(text, "\n    storage_root:") {
		if strings.Contains(text, "mode: \"databases\"") && strings.Contains(text, "storage_root: \""+root+"\"") {
			return nil
		}
		return fmt.Errorf("refusing to overwrite existing docker profile")
	}
	updated := strings.Replace(text, "docker:\n", fmt.Sprintf("docker:\n  mode: \"databases\"\n  database:\n    storage_root: \"%s\"\n", root), 1)
	return os.WriteFile(path, []byte(updated), 0600)
}

func (i *NodeInstaller) writeService(ctx context.Context, node config.Node, name string) error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return nil
	}
	after, wants := "network-online.target", "network-online.target"
	if node.Type == config.NodeNginx {
		after += " nginx.service"
	}
	if node.Type == config.NodeDocker || node.Type == config.NodeDatabases {
		after += " docker.service"
		wants += " docker.service"
	}
	unit := fmt.Sprintf("[Unit]\nDescription=Gateway %s\nAfter=%s\nWants=%s\n\n[Service]\nType=simple\nUser=%s\nGroup=%s\nExecStart=/usr/local/bin/%s run\nRestart=always\nRestartSec=5\nLimitNOFILE=65536\n\n[Install]\nWantedBy=multi-user.target\n", title(node.Type)+" Daemon", after, wants, node.RunUser, node.RunUser, name)
	path := "/etc/systemd/system/" + name + ".service"
	if err := os.WriteFile(path, []byte(unit), 0644); err != nil {
		return err
	}
	if err := i.exec.Run(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := i.exec.Run(ctx, "systemctl", "enable", name); err != nil {
		return err
	}
	return i.exec.Run(ctx, "systemctl", "restart", name)
}
