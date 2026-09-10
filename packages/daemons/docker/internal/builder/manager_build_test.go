package builder

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
