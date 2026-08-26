package builder

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func validBuildCommand() *pb.DockerBuildCommand {
	return &pb.DockerBuildCommand{
		BuildId: "11111111-1111-4111-8111-111111111111", RepositoryUrl: "https://git.example.com/acme/app.git",
		Ref: "refs/heads/main", CommitSha: strings.Repeat("a", 40), DockerfilePath: "Dockerfile", ContextPath: ".",
		Platform: "linux/amd64", OutputRepository: "gateway/acme-app", OutputTag: "build-1",
		CheckoutCredential: []byte(`{"username":"builder","password":"secret"}`), CpuLimitMillis: DefaultCPULimitMillis,
		MemoryLimitBytes: DefaultMemoryLimitBytes, DiskLimitBytes: DefaultDiskLimitBytes, TimeoutSeconds: 1800,
	}
}

func TestBuildValidationAcceptsBuildSecretsAndRejectsInvalidSecretPayloads(t *testing.T) {
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, nil)
	command := validBuildCommand()
	command.BuildSecrets = map[string][]byte{"NPM_TOKEN": []byte("secret")}
	if err := manager.validate(command); err != nil {
		t.Fatalf("valid Build Secret was rejected: %v", err)
	}
	command.BuildSecrets = map[string][]byte{"bad/name": []byte("secret")}
	if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "secret name") {
		t.Fatalf("invalid Build Secret name was accepted: %v", err)
	}
	command.BuildSecrets = map[string][]byte{"EMPTY": nil}
	if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "64 KiB") {
		t.Fatalf("empty Build Secret was accepted: %v", err)
	}
}

func validPagesBuildCommand() *pb.DockerBuildCommand {
	command := validBuildCommand()
	command.OutputKind = "pages_archive"
	command.ApplicationRoot = "apps/web"
	command.PackageManager = "pnpm"
	command.PackageManagerVersion = "10.15.0"
	command.NodeVersion = "24"
	command.BuildScript = "build"
	command.ArtifactDirectory = "dist"
	command.BuildArgs = map[string]string{"VITE_API_URL": "https://api.example.com"}
	command.BuildSecrets = map[string][]byte{"NPM_TOKEN": []byte("super-secret")}
	return command
}

func TestPagesBuildValidationRejectsPublicSecretsAndPathEscape(t *testing.T) {
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, nil)
	command := validPagesBuildCommand()
	if err := manager.validate(command); err != nil {
		t.Fatalf("valid Pages build was rejected: %v", err)
	}
	command.BuildSecrets = map[string][]byte{"VITE_TOKEN": []byte("not-private")}
	if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "private environment") {
		t.Fatalf("public Pages Build Secret was accepted: %v", err)
	}
	command = validPagesBuildCommand()
	command.ArtifactDirectory = "../dist"
	if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "inside the checkout") {
		t.Fatalf("escaping Pages artifact directory was accepted: %v", err)
	}
}

func TestRenderPagesDockerfileUsesGeneratedBuildRecipe(t *testing.T) {
	command := validPagesBuildCommand()
	dockerfile, err := renderPagesDockerfile(command)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"FROM docker.io/library/node:24-bookworm-slim AS build",
		"WORKDIR /workspace/apps/web",
		"ARG VITE_API_URL",
		"ENV VITE_API_URL=${VITE_API_URL}",
		"--mount=type=secret,id=NPM_TOKEN,required=true",
		"corepack prepare 'pnpm@10.15.0' --activate",
		"pnpm install --frozen-lockfile",
		"pnpm run 'build'",
		"COPY --from=build /workspace/apps/web/dist/ /",
	} {
		if !strings.Contains(dockerfile, expected) {
			t.Fatalf("generated Pages Dockerfile is missing %q:\n%s", expected, dockerfile)
		}
	}
	if strings.Contains(dockerfile, "super-secret") {
		t.Fatal("generated Pages Dockerfile contains a Build Secret value")
	}
	if strings.Contains(dockerfile, "# syntax=") {
		t.Fatal("generated Pages Dockerfile must use the configured builtin dockerfile frontend")
	}
}

func TestPagesBuildControlFilesStayOutsideRepositoryCheckout(t *testing.T) {
	workspace := t.TempDir()
	jobDir := filepath.Join(workspace, validPagesBuildCommand().GetBuildId())
	if err := os.Mkdir(jobDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(workspace, "outside")
	if err := os.WriteFile(outside, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".dockerignore", ".gateway-pages.Dockerfile"} {
		if err := os.Symlink(outside, filepath.Join(jobDir, name)); err != nil {
			t.Fatal(err)
		}
	}
	manager := NewManager(DefaultRuntimeConfig(0), workspace, DefaultGitAskpassPath, nil)
	command := validPagesBuildCommand()
	err := manager.buildPages(context.Background(), command, jobDir, filepath.Join(jobDir, "metadata.json"), "image")
	if err == nil {
		t.Fatal("Pages build unexpectedly completed without a BuildKit worker")
	}
	content, readErr := os.ReadFile(outside)
	if readErr != nil || string(content) != "unchanged" {
		t.Fatalf("repository symlink target was modified: content=%q err=%v", content, readErr)
	}
}

func TestBuildLogRedactsBuildSecretValues(t *testing.T) {
	var emitted *pb.DockerBuildEvent
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, func(event *pb.DockerBuildEvent) {
		emitted = event
	})
	manager.secrets["build-1"] = []string{"super-secret"}
	manager.log("build-1", []byte("token=super-secret"))
	if emitted == nil || strings.Contains(string(emitted.LogChunk), "super-secret") || !strings.Contains(string(emitted.LogChunk), "[REDACTED]") {
		t.Fatalf("Build Secret was not redacted: %#v", emitted)
	}
}

func TestRegistryScanEnvironmentUsesTheManagedProxyCA(t *testing.T) {
	environment := registryScanEnvironment(
		[]string{"PATH=/usr/bin", "SYFT_REGISTRY_CA_CERT=/tmp/stale", "GRYPE_REGISTRY_CA_CERT=/tmp/stale"},
		"/var/lib/docker-daemon/registry-proxy/ca.pem",
	)
	joined := strings.Join(environment, "\n")
	for _, expected := range []string{
		"SYFT_REGISTRY_CA_CERT=/var/lib/docker-daemon/registry-proxy/ca.pem",
		"GRYPE_REGISTRY_CA_CERT=/var/lib/docker-daemon/registry-proxy/ca.pem",
	} {
		if strings.Count(joined, expected) != 1 {
			t.Fatalf("scan environment missing %q: %v", expected, environment)
		}
	}
	if strings.Contains(joined, "/tmp/stale") {
		t.Fatalf("scan environment retained stale CA settings: %v", environment)
	}
}

func TestStreamingRedactorProtectsShortMultilineAndSplitSecrets(t *testing.T) {
	var output strings.Builder
	redactor := newStreamRedactor([]string{"x", "line-one\nline-two", "chunk-boundary"}, func(chunk []byte) {
		output.Write(chunk)
	})
	for _, chunk := range [][]byte{
		[]byte("short=x multiline=line-one\n"),
		[]byte("line-two split=chunk-"),
		[]byte("boundary done"),
	} {
		if _, err := redactor.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	redactor.Flush()
	got := output.String()
	for _, secret := range []string{"x", "line-one\nline-two", "chunk-boundary"} {
		if strings.Contains(got, secret) {
			t.Fatalf("secret %q remained in output %q", secret, got)
		}
	}
}

func TestBuildSecretDirectoryIsOutsideCheckoutAndSecurelyRemoved(t *testing.T) {
	workspace := t.TempDir()
	jobDir := filepath.Join(workspace, "11111111-1111-4111-8111-111111111111")
	if err := os.Mkdir(jobDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secretDir, err := os.MkdirTemp(workspace, ".gateway-build-secrets-")
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(secretDir, jobDir+string(os.PathSeparator)) {
		t.Fatalf("secret directory %s is inside checkout %s", secretDir, jobDir)
	}
	secretPath := filepath.Join(secretDir, "TOKEN")
	if err := os.WriteFile(secretPath, []byte("sensitive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := secureRemoveAll(secretDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(secretDir); !os.IsNotExist(err) {
		t.Fatalf("secret directory still exists: %v", err)
	}
}

func TestPrepareJobDirectoryRemovesStaleCheckoutFromExpiredLease(t *testing.T) {
	jobDir := filepath.Join(t.TempDir(), "11111111-1111-4111-8111-111111111111")
	staleGitDir := filepath.Join(jobDir, ".git")
	if err := os.MkdirAll(staleGitDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staleGitDir, "config"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := prepareJobDirectory(jobDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(staleGitDir); !os.IsNotExist(err) {
		t.Fatalf("stale checkout still exists: %v", err)
	}
	info, err := os.Stat(jobDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("job directory mode = %o, want 700", info.Mode().Perm())
	}
}

func TestRunCommandInterruptsGracefullyOnCancellation(t *testing.T) {
	workspace := t.TempDir()
	readyPath := filepath.Join(workspace, "ready")
	interruptedPath := filepath.Join(workspace, "interrupted")
	manager := NewManager(DefaultRuntimeConfig(0), workspace, DefaultGitAskpassPath, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- manager.runCommand(
			ctx,
			"build-1",
			workspace,
			os.Environ(),
			"sh",
			"-c",
			"trap 'printf interrupted > "+interruptedPath+"; exit 0' INT; printf ready > "+readyPath+"; while :; do :; done",
		)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper command did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled command did not exit during the graceful interruption window")
	}
	if content, err := os.ReadFile(interruptedPath); err != nil || string(content) != "interrupted" {
		t.Fatalf("command did not handle interrupt gracefully: content=%q err=%v", content, err)
	}
}

func TestCleanupStaleJobDirsRemovesOnlyBuildWorkspaces(t *testing.T) {
	workspace := t.TempDir()
	staleJob := filepath.Join(workspace, "11111111-1111-4111-8111-111111111111")
	if err := os.MkdirAll(filepath.Join(staleJob, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(workspace, "keep-me")
	if err := os.Mkdir(marker, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := cleanupStaleJobDirs(workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(staleJob); !os.IsNotExist(err) {
		t.Fatalf("stale build workspace still exists: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("unrelated workspace entry was removed: %v", err)
	}
}

func TestBuildValidationRejectsPathEscapeAndMissingLimits(t *testing.T) {
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, nil)
	command := validBuildCommand()
	command.ContextPath = "../host"
	if err := manager.validate(command); err == nil {
		t.Fatal("context path escape was accepted")
	}
	command = validBuildCommand()
	command.MemoryLimitBytes = 0
	if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "resource limits") {
		t.Fatalf("missing limits were not rejected: %v", err)
	}
}

func TestBuildValidationRejectsUnenforcedResourceProfiles(t *testing.T) {
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, nil)
	for name, mutate := range map[string]func(*pb.DockerBuildCommand){
		"cpu":    func(command *pb.DockerBuildCommand) { command.CpuLimitMillis-- },
		"memory": func(command *pb.DockerBuildCommand) { command.MemoryLimitBytes-- },
		"disk":   func(command *pb.DockerBuildCommand) { command.DiskLimitBytes-- },
	} {
		t.Run(name, func(t *testing.T) {
			command := validBuildCommand()
			mutate(command)
			if err := manager.validate(command); err == nil || !strings.Contains(err.Error(), "enforced isolated worker profile") {
				t.Fatalf("unenforced %s profile was accepted: %v", name, err)
			}
		})
	}
}

func TestDirectoryUsageDoesNotFollowSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(filepath.Join(root, "inside"), []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte(strings.Repeat("x", 1024)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside-link")); err != nil {
		t.Fatal(err)
	}
	usage, err := directoryUsage(root)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 5 {
		t.Fatalf("unexpected directory usage: %d", usage)
	}
}

func TestBuildValidationRequiresCanonicalUUID(t *testing.T) {
	manager := NewManager(DefaultRuntimeConfig(0), t.TempDir(), DefaultGitAskpassPath, nil)
	for _, invalid := range []string{
		"11111111-1111-1111-1111-111111111111",
		"11111111-1111-4111-c111-111111111111",
		"11111111-1111-4111-8111-11111111111Z",
	} {
		command := validBuildCommand()
		command.BuildId = invalid
		if err := manager.validate(command); err == nil {
			t.Fatalf("invalid build id was accepted: %s", invalid)
		}
	}
}

func TestBuildMetadataRequiresImmutableDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata.json")
	validDigest := "sha256:" + strings.Repeat("a", 64)
	if err := os.WriteFile(path, []byte(`{"containerimage.digest":"`+validDigest+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata, err := readBuildMetadata(path)
	if err != nil || metadata.Digest != validDigest {
		t.Fatalf("unexpected metadata: %#v %v", metadata, err)
	}
	if err := os.WriteFile(path, []byte(`{"containerimage.digest":"sha256:abc"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBuildMetadata(path); err == nil {
		t.Fatal("short sha256 digest was accepted")
	}
	if err := os.WriteFile(path, []byte(`{"containerimage.digest":"latest"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBuildMetadata(path); err == nil {
		t.Fatal("mutable metadata was accepted")
	}
}

func TestGrypeSummaryIsPolicyReady(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan.json")
	data := `{"matches":[{"vulnerability":{"id":"CVE-2026-1001","severity":"Critical","fix":{"versions":["2.0.1"],"state":"fixed"}},"artifact":{"name":"openssl","version":"2.0.0","type":"apk"}},{"vulnerability":{"id":"CVE-2026-1002","severity":"High"},"artifact":{"name":"curl","version":"8.0.0","type":"apk"}},{"vulnerability":{"id":"CVE-2026-1003","severity":"High"},"artifact":{"name":"zlib","version":"1.2.13","type":"apk"}}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	summary, err := summarizeGrype(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, `"critical":1`) || !strings.Contains(summary, `"high":2`) {
		t.Fatalf("unexpected scan summary: %s", summary)
	}
	if !strings.Contains(summary, `"id":"CVE-2026-1001"`) || !strings.Contains(summary, `"packageName":"openssl"`) || !strings.Contains(summary, `"fixedVersions":["2.0.1"]`) {
		t.Fatalf("scan summary did not retain vulnerability details: %s", summary)
	}
}
