package builder

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	DefaultGitAskpassPath    = "/usr/local/lib/gateway-builder/git-askpass"
	maxBuildLogChunk         = 64 * 1024
	maxScanVulnerabilities   = 100
	commandCancellationGrace = 10 * time.Second
)

var (
	buildIDPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	commitSHAPattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	imageDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	repositoryPattern  = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)
	pagesPathPattern   = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	environmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	errDiskLimit       = errors.New("builder disk limit exceeded")
)

type EventSink func(*pb.DockerBuildEvent)

type Manager struct {
	config      RuntimeConfig
	workspace   string
	askpass     string
	emit        EventSink
	mu          sync.Mutex
	jobs        map[string]context.CancelFunc
	secrets     map[string][]string
	cleanupOnce sync.Once
	cleanupErr  error
	sequence    atomic.Uint64
	executable  func(string) (string, error)
}

type checkoutCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type buildMetadata struct {
	Digest string
	Size   int64
}

func NewManager(config RuntimeConfig, workspace, askpass string, emit EventSink) *Manager {
	return &Manager{
		config: config, workspace: workspace, askpass: askpass, emit: emit, jobs: map[string]context.CancelFunc{}, secrets: map[string][]string{},
		executable: exec.LookPath,
	}
}

func (m *Manager) Ready() error {
	if err := m.config.Validate(); err != nil {
		return err
	}
	for _, binary := range []string{"git", "buildctl", "syft", "grype"} {
		if _, err := m.executable(binary); err != nil {
			return fmt.Errorf("required builder tool %s is unavailable", binary)
		}
	}
	for _, socket := range []string{m.config.BuildkitSocket, m.config.ContainerdSocket} {
		info, err := os.Stat(socket)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("builder runtime socket is unavailable: %s", socket)
		}
	}
	if info, err := os.Stat(m.askpass); err != nil || info.Mode().Perm()&0o022 != 0 {
		return errors.New("builder Git askpass helper is missing or writable by an untrusted user")
	}
	return nil
}

func (m *Manager) Start(command *pb.DockerBuildCommand) error {
	if err := m.validate(command); err != nil {
		return err
	}
	if err := m.Ready(); err != nil {
		return err
	}
	m.cleanupOnce.Do(func() {
		if err := cleanupStaleSecretDirs(m.workspace); err != nil {
			m.cleanupErr = err
			return
		}
		m.cleanupErr = cleanupStaleJobDirs(m.workspace)
	})
	if m.cleanupErr != nil {
		return fmt.Errorf("clean stale builder workspace: %w", m.cleanupErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(command.GetTimeoutSeconds())*time.Second)
	m.mu.Lock()
	if _, exists := m.jobs[command.GetBuildId()]; exists {
		m.mu.Unlock()
		cancel()
		return errors.New("build is already running")
	}
	if len(m.jobs) >= m.config.MaxParallelism {
		m.mu.Unlock()
		cancel()
		return errors.New("builder is at its isolated job capacity")
	}
	m.jobs[command.GetBuildId()] = cancel
	secretValues := make([]string, 0, len(command.GetBuildSecrets())+1)
	for _, value := range command.GetBuildSecrets() {
		secretValues = append(secretValues, string(value))
	}
	var credential checkoutCredential
	if json.Unmarshal(command.GetCheckoutCredential(), &credential) == nil && credential.Password != "" {
		secretValues = append(secretValues, credential.Password)
	}
	m.secrets[command.GetBuildId()] = secretValues
	m.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			m.mu.Lock()
			delete(m.jobs, command.GetBuildId())
			delete(m.secrets, command.GetBuildId())
			m.mu.Unlock()
		}()
		heartbeatDone := make(chan struct{})
		go m.emitHeartbeats(ctx, command.GetBuildId(), heartbeatDone)
		m.run(ctx, command)
		close(heartbeatDone)
	}()
	return nil
}

func (m *Manager) emitHeartbeats(ctx context.Context, buildID string, done <-chan struct{}) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: "heartbeat", OccurredAtUnixMs: time.Now().UnixMilli()})
		}
	}
}

func (m *Manager) Cancel(buildID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	cancel := m.jobs[buildID]
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func (m *Manager) validate(command *pb.DockerBuildCommand) error {
	if command == nil || !buildIDPattern.MatchString(command.GetBuildId()) {
		return errors.New("invalid build id")
	}
	if !commitSHAPattern.MatchString(command.GetCommitSha()) {
		return errors.New("build commit must be an exact lowercase SHA-1")
	}
	repositoryURL, err := url.Parse(command.GetRepositoryUrl())
	if err != nil || repositoryURL.Scheme != "https" || repositoryURL.Host == "" || repositoryURL.User != nil {
		return errors.New("builder checkout requires an HTTPS repository URL without embedded credentials")
	}
	if !repositoryPattern.MatchString(command.GetOutputRepository()) {
		return errors.New("invalid output repository")
	}
	if command.GetOutputTag() == "" || strings.ContainsAny(command.GetOutputTag(), "@/ \\") {
		return errors.New("invalid output tag")
	}
	if command.GetPlatform() != "linux/amd64" && command.GetPlatform() != "linux/arm64" {
		return errors.New("unsupported build platform")
	}
	for _, path := range []string{command.GetDockerfilePath(), command.GetContextPath()} {
		if path == "" || filepath.IsAbs(path) || filepath.Clean(path) != path || path == ".." || strings.HasPrefix(path, "../") {
			return errors.New("Dockerfile and context paths must remain inside the checkout")
		}
	}
	outputKind := command.GetOutputKind()
	if outputKind == "" {
		outputKind = "oci_image"
	}
	if outputKind != "oci_image" && outputKind != "pages_archive" {
		return errors.New("unsupported build output kind")
	}
	if outputKind == "pages_archive" {
		for _, path := range []string{command.GetApplicationRoot(), command.GetArtifactDirectory()} {
			if path == "" || !pagesPathPattern.MatchString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path || path == ".." || strings.HasPrefix(path, "../") {
				return errors.New("Pages build paths must remain inside the checkout")
			}
		}
		if command.GetPackageManager() != "npm" && command.GetPackageManager() != "pnpm" && command.GetPackageManager() != "yarn" {
			return errors.New("unsupported Pages package manager")
		}
		if command.GetNodeVersion() != "20" && command.GetNodeVersion() != "22" && command.GetNodeVersion() != "24" {
			return errors.New("unsupported Pages Node.js version")
		}
		if command.GetBuildScript() == "" || len(command.GetBuildScript()) > 128 || strings.ContainsAny(command.GetBuildScript(), "\x00\r\n") {
			return errors.New("invalid Pages build script")
		}
		if version := command.GetPackageManagerVersion(); version != "" && !regexp.MustCompile(`^[A-Za-z0-9._+:-]+$`).MatchString(version) {
			return errors.New("invalid package manager version")
		}
		for name := range command.GetBuildArgs() {
			if !environmentPattern.MatchString(name) {
				return errors.New("invalid Pages build variable name")
			}
		}
	}
	for name, value := range command.GetBuildSecrets() {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`).MatchString(name) {
			return errors.New("invalid build secret name")
		}
		if len(value) == 0 || len(value) > 65_536 {
			return errors.New("build secret value must be between 1 byte and 64 KiB")
		}
		if outputKind == "pages_archive" && (!environmentPattern.MatchString(name) || strings.HasPrefix(name, "VITE_")) {
			return errors.New("Pages Build Secret names must be private environment variable names")
		}
	}
	if command.GetCpuLimitMillis() <= 0 || command.GetMemoryLimitBytes() <= 0 || command.GetDiskLimitBytes() <= 0 {
		return errors.New("builder resource limits are required")
	}
	if command.GetCpuLimitMillis() != m.config.CPULimitMillis ||
		command.GetMemoryLimitBytes() != m.config.MemoryLimitBytes ||
		command.GetDiskLimitBytes() != m.config.DiskLimitBytes {
		return errors.New("build resource limits do not match the enforced isolated worker profile")
	}
	if command.GetTimeoutSeconds() < 30 || command.GetTimeoutSeconds() > 6*60*60 {
		return errors.New("builder timeout must be between 30 seconds and 6 hours")
	}
	return nil
}

func (m *Manager) run(ctx context.Context, command *pb.DockerBuildCommand) {
	jobDir := filepath.Join(m.workspace, command.GetBuildId())
	defer os.RemoveAll(jobDir)
	if err := prepareJobDirectory(jobDir); err != nil {
		m.fail(command, "WORKSPACE_CREATE_FAILED", err)
		return
	}
	if err := m.prune(ctx, command.GetBuildId()); err != nil {
		m.fail(command, "BUILDER_CACHE_RESET_FAILED", err)
		return
	}
	defer m.pruneAfterJob(command.GetBuildId())
	jobCtx, cancelJob := context.WithCancelCause(ctx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		if err := m.monitorStorage(
			jobCtx,
			command.GetDiskLimitBytes(),
			jobDir,
			m.config.BuildkitStateDir,
			m.config.ContainerdRootDir,
		); err != nil {
			cancelJob(err)
		}
	}()
	defer func() {
		cancelJob(nil)
		<-monitorDone
	}()
	m.status(command, "checking_out")
	if err := m.checkout(jobCtx, command, jobDir); err != nil {
		m.failForContext(command, jobCtx, "CHECKOUT_FAILED", err)
		return
	}
	m.status(command, "building")
	metadataPath := filepath.Join(jobDir, "build-metadata.json")
	imageRef := "127.0.0.1:5443/" + command.GetOutputRepository() + ":" + command.GetOutputTag()
	build := m.build
	if command.GetOutputKind() == "pages_archive" {
		build = m.buildPages
	}
	if err := build(jobCtx, command, jobDir, metadataPath, imageRef); err != nil {
		m.failForContext(command, jobCtx, "BUILD_FAILED", err)
		return
	}
	metadata, err := readBuildMetadata(metadataPath)
	if err != nil {
		m.fail(command, "BUILD_METADATA_INVALID", err)
		return
	}
	if measured, measureErr := m.measureImage(jobCtx, command.GetOutputRepository(), metadata.Digest); measureErr == nil {
		metadata.Size = measured
	} else {
		m.log(command.GetBuildId(), []byte("artifact size measurement failed: "+measureErr.Error()))
	}
	m.status(command, "scanning")
	if command.GetOutputKind() == "pages_archive" {
		m.emitEvent(&pb.DockerBuildEvent{
			BuildId: command.GetBuildId(), Status: "succeeded", ArtifactRepository: command.GetOutputRepository(),
			ArtifactDigest: metadata.Digest, ArtifactSizeBytes: metadata.Size, Platform: command.GetPlatform(),
			PolicyDecision: "pending", OccurredAtUnixMs: time.Now().UnixMilli(),
		})
		return
	}
	scanSummary, err := m.scan(jobCtx, command, jobDir, imageRef, metadata.Digest)
	if err != nil {
		m.failForContext(command, jobCtx, "ARTIFACT_POLICY_FAILED", err)
		return
	}
	m.emitEvent(&pb.DockerBuildEvent{
		BuildId: command.GetBuildId(), Status: "succeeded", ArtifactRepository: command.GetOutputRepository(),
		ArtifactDigest: metadata.Digest, ArtifactSizeBytes: metadata.Size, Platform: command.GetPlatform(),
		ScanSummaryJson: scanSummary,
		PolicyDecision:  "pending", OccurredAtUnixMs: time.Now().UnixMilli(),
	})
}

func prepareJobDirectory(jobDir string) error {
	// A daemon restart can leave the checkout for an expired build lease behind.
	// Retried attempts reuse the build ID, so always recreate the workspace before
	// initializing Git instead of inheriting a partial repository from the old process.
	if err := os.RemoveAll(jobDir); err != nil {
		return err
	}
	return os.MkdirAll(jobDir, 0o700)
}

func (m *Manager) checkout(ctx context.Context, command *pb.DockerBuildCommand, jobDir string) error {
	credential := checkoutCredential{Username: "oauth2", Password: string(command.GetCheckoutCredential())}
	if len(command.GetCheckoutCredential()) == 0 {
		return errors.New("checkout credential is required")
	}
	_ = json.Unmarshal(command.GetCheckoutCredential(), &credential)
	if credential.Username == "" || credential.Password == "" || strings.ContainsAny(credential.Username, "\r\n") || strings.ContainsAny(credential.Password, "\r\n") {
		return errors.New("checkout credential is invalid")
	}
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS="+m.askpass,
		"GATEWAY_GIT_USERNAME="+credential.Username, "GATEWAY_GIT_PASSWORD="+credential.Password,
	)
	for _, step := range [][]string{
		{"git", "init", "--quiet", jobDir},
		{"git", "-C", jobDir, "remote", "add", "origin", command.GetRepositoryUrl()},
		{"git", "-C", jobDir, "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "origin", command.GetRef()},
		{"git", "-C", jobDir, "checkout", "--quiet", "--detach", command.GetCommitSha()},
	} {
		if err := m.runCommand(ctx, command.GetBuildId(), "", env, step[0], step[1:]...); err != nil {
			return err
		}
	}
	output, err := exec.CommandContext(ctx, "git", "-C", jobDir, "rev-parse", "HEAD").Output()
	if err != nil || strings.TrimSpace(string(output)) != command.GetCommitSha() {
		return errors.New("checked out commit does not match the requested SHA")
	}
	return nil
}

func (m *Manager) build(ctx context.Context, command *pb.DockerBuildCommand, jobDir, metadataPath, imageRef string) error {
	contextDir, err := containedPath(jobDir, command.GetContextPath())
	if err != nil {
		return err
	}
	dockerfileAbsolute, err := containedPath(jobDir, command.GetDockerfilePath())
	if err != nil {
		return err
	}
	args := []string{"--addr", "unix://" + m.config.BuildkitSocket, "build", "--frontend", "dockerfile.v0",
		"--local", "context=" + contextDir, "--local", "dockerfile=" + filepath.Dir(dockerfileAbsolute),
		"--opt", "filename=" + filepath.Base(dockerfileAbsolute), "--opt", "platform=" + command.GetPlatform(),
		"--metadata-file", metadataPath,
		"--output", "type=image,name=" + imageRef + ",push=true",
	}
	keys := make([]string, 0, len(command.GetBuildArgs()))
	for key := range command.GetBuildArgs() {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			return errors.New("invalid build argument name")
		}
		args = append(args, "--opt", "build-arg:"+key+"="+command.GetBuildArgs()[key])
	}
	secretDir := ""
	if len(command.GetBuildSecrets()) > 0 {
		secretDir, err = os.MkdirTemp(m.workspace, ".gateway-build-secrets-")
		if err != nil {
			return fmt.Errorf("create Build Secret directory: %w", err)
		}
		if err := os.Chmod(secretDir, 0o700); err != nil {
			_ = os.RemoveAll(secretDir)
			return fmt.Errorf("protect Build Secret directory: %w", err)
		}
		defer secureRemoveAll(secretDir)
		secretNames := make([]string, 0, len(command.GetBuildSecrets()))
		for name := range command.GetBuildSecrets() {
			secretNames = append(secretNames, name)
		}
		sort.Strings(secretNames)
		for _, name := range secretNames {
			path := filepath.Join(secretDir, name)
			if err := os.WriteFile(path, command.GetBuildSecrets()[name], 0o600); err != nil {
				return fmt.Errorf("write Build Secret %s: %w", name, err)
			}
			args = append(args, "--secret", "id="+name+",src="+path)
		}
	}
	return m.runCommand(ctx, command.GetBuildId(), jobDir, os.Environ(), "buildctl", args...)
}

func (m *Manager) buildPages(ctx context.Context, command *pb.DockerBuildCommand, jobDir, metadataPath, imageRef string) error {
	controlDir, err := os.MkdirTemp(m.workspace, ".gateway-pages-control-")
	if err != nil {
		return fmt.Errorf("create managed Pages build directory: %w", err)
	}
	if err := os.Chmod(controlDir, 0o700); err != nil {
		_ = os.RemoveAll(controlDir)
		return fmt.Errorf("protect managed Pages build directory: %w", err)
	}
	defer secureRemoveAll(controlDir)
	dockerfilePath := filepath.Join(controlDir, "Dockerfile")
	dockerfile, err := renderPagesDockerfile(command)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dockerfilePath, []byte(dockerfile), 0o600); err != nil {
		return fmt.Errorf("write managed Pages Dockerfile: %w", err)
	}
	args := []string{"--addr", "unix://" + m.config.BuildkitSocket, "build", "--frontend", "dockerfile.v0",
		"--local", "context=" + jobDir, "--local", "dockerfile=" + controlDir,
		"--opt", "filename=" + filepath.Base(dockerfilePath), "--opt", "platform=" + command.GetPlatform(),
		"--metadata-file", metadataPath,
		"--output", "type=image,name=" + imageRef + ",push=true,compression=gzip,force-compression=true,oci-mediatypes=true",
	}
	keys := make([]string, 0, len(command.GetBuildArgs()))
	for key := range command.GetBuildArgs() {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, "--opt", "build-arg:"+key+"="+command.GetBuildArgs()[key])
	}
	secretDir := ""
	if len(command.GetBuildSecrets()) > 0 {
		secretDir, err = os.MkdirTemp(m.workspace, ".gateway-build-secrets-")
		if err != nil {
			return fmt.Errorf("create Build Secret directory: %w", err)
		}
		if err := os.Chmod(secretDir, 0o700); err != nil {
			_ = os.RemoveAll(secretDir)
			return fmt.Errorf("protect Build Secret directory: %w", err)
		}
		defer secureRemoveAll(secretDir)
		secretNames := make([]string, 0, len(command.GetBuildSecrets()))
		for name := range command.GetBuildSecrets() {
			secretNames = append(secretNames, name)
		}
		sort.Strings(secretNames)
		for _, name := range secretNames {
			path := filepath.Join(secretDir, name)
			if err := os.WriteFile(path, command.GetBuildSecrets()[name], 0o600); err != nil {
				return fmt.Errorf("write Build Secret %s: %w", name, err)
			}
			args = append(args, "--secret", "id="+name+",src="+path)
		}
	}
	return m.runCommand(ctx, command.GetBuildId(), jobDir, os.Environ(), "buildctl", args...)
}

func renderPagesDockerfile(command *pb.DockerBuildCommand) (string, error) {
	manager := command.GetPackageManager()
	version := command.GetPackageManagerVersion()
	setup := ""
	install := ""
	run := ""
	switch manager {
	case "npm":
		install = "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi"
		run = "npm run " + shellQuote(command.GetBuildScript())
	case "pnpm":
		if version == "" {
			version = "10"
		}
		setup = "corepack enable && corepack prepare " + shellQuote("pnpm@"+version) + " --activate && "
		install = "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi"
		run = "pnpm run " + shellQuote(command.GetBuildScript())
	case "yarn":
		if version == "" {
			version = "4"
		}
		setup = "corepack enable && corepack prepare " + shellQuote("yarn@"+version) + " --activate && "
		install = "if [ -f yarn.lock ]; then yarn install --immutable; else yarn install; fi"
		run = "yarn run " + shellQuote(command.GetBuildScript())
	default:
		return "", errors.New("unsupported Pages package manager")
	}
	variableNames := make([]string, 0, len(command.GetBuildArgs()))
	for name := range command.GetBuildArgs() {
		variableNames = append(variableNames, name)
	}
	sort.Strings(variableNames)
	secretNames := make([]string, 0, len(command.GetBuildSecrets()))
	for name := range command.GetBuildSecrets() {
		secretNames = append(secretNames, name)
	}
	sort.Strings(secretNames)
	lines := []string{
		"FROM docker.io/library/node:" + command.GetNodeVersion() + "-bookworm-slim AS build",
		"WORKDIR /workspace",
		"COPY . .",
		"WORKDIR /workspace/" + command.GetApplicationRoot(),
	}
	for _, name := range variableNames {
		lines = append(lines, "ARG "+name, "ENV "+name+"=${"+name+"}")
	}
	mounts := make([]string, 0, len(secretNames))
	exports := make([]string, 0, len(secretNames))
	for _, name := range secretNames {
		mounts = append(mounts, "--mount=type=secret,id="+name+",required=true")
		exports = append(exports, "export "+name+"=\"$(cat /run/secrets/"+name+")\"")
	}
	runPrefix := "RUN"
	if len(mounts) > 0 {
		runPrefix += " " + strings.Join(mounts, " ")
	}
	commands := []string{"set -eu"}
	commands = append(commands, exports...)
	commands = append(commands, setup+install, run)
	lines = append(lines, runPrefix+" "+strings.Join(commands, "; "))
	lines = append(lines,
		"FROM scratch AS pages",
		"COPY --from=build /workspace/"+command.GetApplicationRoot()+"/"+command.GetArtifactDirectory()+"/ /",
	)
	return strings.Join(lines, "\n") + "\n", nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (m *Manager) scan(ctx context.Context, command *pb.DockerBuildCommand, jobDir, imageRef, imageDigest string) (string, error) {
	tagSeparator := strings.LastIndex(imageRef, ":")
	if tagSeparator < 0 {
		return "", errors.New("built image reference has no tag")
	}
	subject := imageRef[:tagSeparator] + "@" + imageDigest
	sbomPath := filepath.Join(jobDir, "sbom.cdx.json")
	scanEnv := registryScanEnvironment(os.Environ(), m.config.RegistryCAPath)
	if err := m.runCommand(ctx, command.GetBuildId(), jobDir, scanEnv, "syft", "registry:"+subject, "-o", "cyclonedx-json="+sbomPath); err != nil {
		return "", err
	}
	scanPath := filepath.Join(jobDir, "scan.json")
	if err := m.runCommand(ctx, command.GetBuildId(), jobDir, scanEnv, "grype", "sbom:"+sbomPath, "-o", "json", "--file", scanPath); err != nil {
		return "", err
	}
	summary, err := summarizeGrype(scanPath)
	return summary, err
}

func registryScanEnvironment(base []string, caPath string) []string {
	const syftCA = "SYFT_REGISTRY_CA_CERT="
	const grypeCA = "GRYPE_REGISTRY_CA_CERT="
	environment := make([]string, 0, len(base)+2)
	for _, entry := range base {
		if strings.HasPrefix(entry, syftCA) || strings.HasPrefix(entry, grypeCA) {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment, syftCA+caPath, grypeCA+caPath)
}

func (m *Manager) runCommand(ctx context.Context, buildID, dir string, env []string, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		return command.Process.Signal(os.Interrupt)
	}
	command.WaitDelay = commandCancellationGrace
	command.Dir = dir
	command.Env = env
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	copyLogs := func(reader io.Reader) {
		defer wg.Done()
		redactor := newStreamRedactor(m.secretValues(buildID), func(chunk []byte) {
			m.emitLog(buildID, chunk)
		})
		buffer := make([]byte, maxBuildLogChunk)
		_, _ = io.CopyBuffer(redactor, reader, buffer)
		redactor.Flush()
	}
	wg.Add(2)
	go copyLogs(stdout)
	go copyLogs(stderr)
	err = command.Wait()
	wg.Wait()
	return err
}

func (m *Manager) prune(ctx context.Context, buildID string) error {
	return m.runCommand(
		ctx,
		buildID,
		"",
		os.Environ(),
		"buildctl",
		"--addr",
		"unix://"+m.config.BuildkitSocket,
		"prune",
		"--all",
	)
}

func (m *Manager) pruneAfterJob(buildID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := m.prune(ctx, buildID); err != nil {
		m.log(buildID, []byte("builder cache cleanup failed: "+err.Error()))
	}
}

func (m *Manager) monitorStorage(ctx context.Context, limit int64, paths ...string) error {
	check := func() error {
		usage, err := directoryUsage(paths...)
		if err != nil {
			return fmt.Errorf("measure isolated builder storage: %w", err)
		}
		if usage > limit {
			return fmt.Errorf("%w: used %d bytes, limit %d bytes", errDiskLimit, usage, limit)
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := check(); err != nil {
				return err
			}
		}
	}
}

func directoryUsage(paths ...string) (int64, error) {
	var total int64
	for _, root := range paths {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				if os.IsNotExist(walkErr) {
					return nil
				}
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			total += info.Size()
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return 0, err
		}
	}
	return total, nil
}

func (m *Manager) failForContext(command *pb.DockerBuildCommand, ctx context.Context, fallbackCode string, err error) {
	cause := context.Cause(ctx)
	switch {
	case errors.Is(cause, errDiskLimit):
		m.fail(command, "BUILD_RESOURCE_LIMIT_EXCEEDED", cause)
	case cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded):
		m.fail(command, "BUILD_RESOURCE_ACCOUNTING_FAILED", cause)
	case errors.Is(cause, context.DeadlineExceeded):
		m.fail(command, "BUILD_TIMEOUT", cause)
	case errors.Is(cause, context.Canceled):
		m.fail(command, "BUILD_CANCELLED", cause)
	default:
		m.fail(command, fallbackCode, err)
	}
}

func (m *Manager) status(command *pb.DockerBuildCommand, status string) {
	m.emitEvent(&pb.DockerBuildEvent{BuildId: command.GetBuildId(), Status: status, OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) fail(command *pb.DockerBuildCommand, code string, err error) {
	m.emitEvent(&pb.DockerBuildEvent{BuildId: command.GetBuildId(), Status: "failed", ErrorCode: code, ErrorMessage: err.Error(), OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) log(buildID string, chunk []byte) {
	redactor := newStreamRedactor(m.secretValues(buildID), func(redacted []byte) {
		m.emitLog(buildID, redacted)
	})
	_, _ = redactor.Write(chunk)
	redactor.Flush()
}

func (m *Manager) secretValues(buildID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.secrets[buildID]...)
}

func (m *Manager) emitLog(buildID string, chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: "log", Sequence: m.sequence.Add(1), LogChunk: append([]byte(nil), chunk...), OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) emitEvent(event *pb.DockerBuildEvent) {
	if m.emit != nil {
		m.emit(event)
	}
}

func containedPath(root, relative string) (string, error) {
	resolved := filepath.Join(root, relative)
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", errors.New("path escapes build checkout")
	}
	return resolved, nil
}

func readBuildMetadata(path string) (buildMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return buildMetadata{}, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return buildMetadata{}, err
	}
	var digest string
	_ = json.Unmarshal(raw["containerimage.digest"], &digest)
	if !imageDigestPattern.MatchString(digest) {
		return buildMetadata{}, errors.New("BuildKit did not return an immutable image digest")
	}
	var descriptor struct {
		Size int64 `json:"size"`
	}
	_ = json.Unmarshal(raw["containerimage.descriptor"], &descriptor)
	return buildMetadata{Digest: digest, Size: max(descriptor.Size, 0)}, nil
}

func (m *Manager) measureImage(ctx context.Context, repository, digest string) (int64, error) {
	caPEM, err := os.ReadFile(m.config.RegistryCAPath)
	if err != nil {
		return 0, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return 0, errors.New("builder registry CA is invalid")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}}
	var visit func(string, int) (int64, error)
	visit = func(reference string, depth int) (int64, error) {
		if depth > 3 {
			return 0, errors.New("registry manifest nesting exceeds limit")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://127.0.0.1:5443/v2/"+repository+"/manifests/"+reference, nil)
		if err != nil {
			return 0, err
		}
		request.Header.Set("Accept", strings.Join([]string{
			"application/vnd.oci.image.index.v1+json",
			"application/vnd.oci.image.manifest.v1+json",
			"application/vnd.docker.distribution.manifest.list.v2+json",
			"application/vnd.docker.distribution.manifest.v2+json",
		}, ", "))
		response, err := client.Do(request)
		if err != nil {
			return 0, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("registry manifest request returned %s", response.Status)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
		if err != nil {
			return 0, err
		}
		var manifest struct {
			Config struct {
				Size int64 `json:"size"`
			} `json:"config"`
			Layers []struct {
				Size int64 `json:"size"`
			} `json:"layers"`
			Manifests []struct {
				Digest string `json:"digest"`
				Size   int64  `json:"size"`
			} `json:"manifests"`
		}
		if err := json.Unmarshal(body, &manifest); err != nil {
			return 0, err
		}
		total := int64(len(body)) + max(manifest.Config.Size, 0)
		for _, layer := range manifest.Layers {
			total += max(layer.Size, 0)
		}
		for _, child := range manifest.Manifests {
			childSize, err := visit(child.Digest, depth+1)
			if err != nil {
				return 0, err
			}
			total += max(childSize, child.Size)
		}
		return total, nil
	}
	return visit(digest, 0)
}
func summarizeGrype(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var report struct {
		Matches []struct {
			Vulnerability struct {
				ID         string `json:"id"`
				Severity   string `json:"severity"`
				Namespace  string `json:"namespace"`
				DataSource string `json:"dataSource"`
				Fix        struct {
					Versions []string `json:"versions"`
					State    string   `json:"state"`
				} `json:"fix"`
			} `json:"vulnerability"`
			Artifact struct {
				Name    string `json:"name"`
				Version string `json:"version"`
				Type    string `json:"type"`
			} `json:"artifact"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		return "", err
	}
	type vulnerabilityFinding struct {
		ID               string   `json:"id"`
		Severity         string   `json:"severity"`
		PackageName      string   `json:"packageName"`
		InstalledVersion string   `json:"installedVersion"`
		PackageType      string   `json:"packageType"`
		FixedVersions    []string `json:"fixedVersions"`
		FixState         string   `json:"fixState"`
		Namespace        string   `json:"namespace"`
		DataSource       string   `json:"dataSource"`
	}
	type scanSummary struct {
		Scanner                  string                 `json:"scanner"`
		Critical                 int                    `json:"critical"`
		High                     int                    `json:"high"`
		Medium                   int                    `json:"medium"`
		Low                      int                    `json:"low"`
		Negligible               int                    `json:"negligible"`
		Unknown                  int                    `json:"unknown"`
		Vulnerabilities          []vulnerabilityFinding `json:"vulnerabilities"`
		VulnerabilitiesTruncated int                    `json:"vulnerabilitiesTruncated"`
	}
	trimValue := func(value string) string {
		runes := []rune(strings.TrimSpace(value))
		if len(runes) > 512 {
			runes = runes[:512]
		}
		return string(runes)
	}
	summary := scanSummary{Scanner: "grype", Vulnerabilities: make([]vulnerabilityFinding, 0, len(report.Matches))}
	for _, match := range report.Matches {
		severity := strings.ToLower(match.Vulnerability.Severity)
		switch severity {
		case "critical":
			summary.Critical++
		case "high":
			summary.High++
		case "medium":
			summary.Medium++
		case "low":
			summary.Low++
		case "negligible":
			summary.Negligible++
		default:
			severity = "unknown"
			summary.Unknown++
		}
		id := trimValue(match.Vulnerability.ID)
		if id == "" {
			continue
		}
		fixedVersions := make([]string, 0, min(len(match.Vulnerability.Fix.Versions), 5))
		for _, version := range match.Vulnerability.Fix.Versions {
			if len(fixedVersions) == 5 {
				break
			}
			if value := trimValue(version); value != "" {
				fixedVersions = append(fixedVersions, value)
			}
		}
		summary.Vulnerabilities = append(summary.Vulnerabilities, vulnerabilityFinding{
			ID:               id,
			Severity:         severity,
			PackageName:      trimValue(match.Artifact.Name),
			InstalledVersion: trimValue(match.Artifact.Version),
			PackageType:      trimValue(match.Artifact.Type),
			FixedVersions:    fixedVersions,
			FixState:         trimValue(match.Vulnerability.Fix.State),
			Namespace:        trimValue(match.Vulnerability.Namespace),
			DataSource:       trimValue(match.Vulnerability.DataSource),
		})
	}
	severityOrder := map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3, "negligible": 4, "unknown": 5}
	sort.SliceStable(summary.Vulnerabilities, func(i, j int) bool {
		left, right := summary.Vulnerabilities[i], summary.Vulnerabilities[j]
		if severityOrder[left.Severity] != severityOrder[right.Severity] {
			return severityOrder[left.Severity] < severityOrder[right.Severity]
		}
		if left.ID != right.ID {
			return left.ID < right.ID
		}
		return left.PackageName < right.PackageName
	})
	if len(summary.Vulnerabilities) > maxScanVulnerabilities {
		summary.VulnerabilitiesTruncated = len(summary.Vulnerabilities) - maxScanVulnerabilities
		summary.Vulnerabilities = summary.Vulnerabilities[:maxScanVulnerabilities]
	}
	encoded, _ := json.Marshal(summary)
	return string(encoded), nil
}
