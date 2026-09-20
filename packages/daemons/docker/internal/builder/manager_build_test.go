package builder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestBuildRejectsMissingOrInvalidCheckoutInputs(t *testing.T) {
	for _, tc := range []struct {
		name, contextPath, dockerfilePath, want string
	}{
		{"missing Dockerfile", ".", "Dockerfile", `Dockerfile "Dockerfile" is not an accessible file`},
		{"directory as Dockerfile", ".", ".", `Dockerfile "." is not an accessible file`},
		{"missing context", "missing", "apps/api/Dockerfile", `build context "missing" is not an accessible directory`},
		{"file as context", "apps/api/Dockerfile", "apps/api/Dockerfile", `build context "apps/api/Dockerfile" is not an accessible directory`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobDir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(jobDir, "apps/api"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(jobDir, "apps/api/Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			manager := NewManager(DefaultRuntimeConfig(0), jobDir, DefaultGitAskpassPath, nil)
			command := validBuildCommand()
			command.ContextPath, command.DockerfilePath = tc.contextPath, tc.dockerfilePath
			err := manager.build(context.Background(), command, jobDir, "metadata.json", "test:build")
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "repository root") {
				t.Fatalf("expected actionable input error before BuildKit starts, got %v", err)
			}
		})
	}
}

func TestBuildUsesNestedDockerfileWithRepositoryRootContext(t *testing.T) {
	jobDir := t.TempDir()
	dockerfileDir := filepath.Join(jobDir, "apps/api")
	if err := os.MkdirAll(dockerfileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dockerfileDir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	argsFile := filepath.Join(t.TempDir(), "args")
	t.Setenv("BUILD_ARGS_PATH", argsFile)
	if err := os.WriteFile(filepath.Join(binDir, "buildctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BUILD_ARGS_PATH\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(DefaultRuntimeConfig(0), jobDir, DefaultGitAskpassPath, nil)
	manager.executable = func(name string) (string, error) {
		return filepath.Join(binDir, name), nil
	}
	command := validBuildCommand()
	command.DockerfilePath = "apps/api/Dockerfile"
	if err := manager.build(context.Background(), command, jobDir, "metadata.json", "test:build"); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"context=" + jobDir + "\n", "dockerfile=" + dockerfileDir + "\n", "filename=Dockerfile\n"} {
		if !strings.Contains(string(args), want) {
			t.Fatalf("missing argument %q in %s", want, args)
		}
	}
}

func TestStoredBuilderImagesAreRemovedInBatchesFromTheBuilderNamespace(t *testing.T) {
	workspace := t.TempDir()
	callsPath := filepath.Join(workspace, "calls")
	refs := make([]string, 0, storedImageRemovalBatch+1)
	for index := range storedImageRemovalBatch + 1 {
		refs = append(refs, fmt.Sprintf("127.0.0.1:5443/gateway/builds/resource:%d", index))
	}
	ctrPath := filepath.Join(workspace, "ctr")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + callsPath + "\ncase \"$*\" in *'images list --quiet') printf '%s\\n' " + strings.Join(refs, " ") + ";; esac\n"
	if err := os.WriteFile(ctrPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(DefaultRuntimeConfig(0), workspace, DefaultGitAskpassPath, nil)
	manager.executable = func(string) (string, error) { return ctrPath, nil }

	if err := manager.removeStoredImages(context.Background()); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	calls := strings.Split(strings.TrimSpace(string(content)), "\n")
	scope := "--address " + DefaultContainerdSocket + " --namespace " + DefaultContainerdNamespace + " images "
	want := []string{
		scope + "list --quiet",
		scope + "remove --sync " + strings.Join(refs[:storedImageRemovalBatch], " "),
		scope + "remove --sync " + refs[storedImageRemovalBatch],
	}
	if !slices.Equal(calls, want) {
		t.Fatalf("unexpected ctr calls:\n%s", strings.Join(calls, "\n"))
	}
}

func TestBuildResultsArePushedWithoutPopulatingTheBuilderImageStore(t *testing.T) {
	workspace := t.TempDir()
	jobDir := filepath.Join(workspace, "job")
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jobDir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	callsPath := filepath.Join(workspace, "calls")
	buildctlPath := filepath.Join(workspace, "buildctl")
	if err := os.WriteFile(buildctlPath, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" >> "+callsPath+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(DefaultRuntimeConfig(0), workspace, DefaultGitAskpassPath, nil)
	manager.executable = func(string) (string, error) { return buildctlPath, nil }
	command := &pb.DockerBuildCommand{BuildId: "build-1", ContextPath: ".", DockerfilePath: "Dockerfile", Platform: "linux/amd64"}

	if err := manager.build(context.Background(), command, jobDir, filepath.Join(workspace, "metadata.json"), "registry/image:tag"); err != nil {
		t.Fatal(err)
	}
	if err := manager.buildPages(context.Background(), validPagesBuildCommand(), jobDir, filepath.Join(workspace, "metadata.json"), "registry/pages:tag"); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	outputs := 0
	for _, argument := range strings.Split(string(content), "\n") {
		if !strings.HasPrefix(argument, "type=image,") {
			continue
		}
		outputs++
		if !strings.Contains(argument, ",push=true") || !strings.HasSuffix(argument, ",store=false") {
			t.Fatalf("image output must push without storing locally: %s", argument)
		}
	}
	if outputs != 2 {
		t.Fatalf("expected two image outputs, got %d", outputs)
	}
}
