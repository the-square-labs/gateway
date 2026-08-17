package runtime

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestProgressReaderReportsDownloadPercent(t *testing.T) {
	var percentages []uint32
	reader := &progressReader{
		reader: bytes.NewReader(make([]byte, 100)),
		total:  100,
		onProgress: func(percent uint32) {
			percentages = append(percentages, percent)
		},
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatal(err)
	}
	if len(percentages) == 0 || percentages[len(percentages)-1] != 100 {
		t.Fatalf("expected final 100%% progress, got %v", percentages)
	}
}

func TestExtractTarWritesRegularBundleFiles(t *testing.T) {
	var archive bytes.Buffer
	w := tar.NewWriter(&archive)
	content := []byte("runsc binary")
	if err := w.WriteHeader(&tar.Header{Name: "runsc", Mode: 0o755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	destination := t.TempDir()
	if err := extractTar(tar.NewReader(bytes.NewReader(archive.Bytes())), destination); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(destination, "runsc"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("unexpected extracted content %q", got)
	}
}

func TestExtractTarRejectsPathTraversal(t *testing.T) {
	var archive bytes.Buffer
	w := tar.NewWriter(&archive)
	content := []byte("unsafe")
	if err := w.WriteHeader(&tar.Header{Name: "../runsc", Mode: 0o755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	if err := extractTar(tar.NewReader(bytes.NewReader(archive.Bytes())), t.TempDir()); err == nil {
		t.Fatal("expected unsafe archive path to be rejected")
	}
}

func TestWriteRunscDockerConfigPreservesExistingConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daemon.json")
	original := []byte(`{"log-driver":"journald","runtimes":{"kata":{"path":"/usr/bin/kata-runtime"}}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	rollback, err := writeRunscDockerConfig(path, "/usr/local/bin/runsc")
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(content, &config); err != nil {
		t.Fatal(err)
	}
	if config["log-driver"] != "journald" {
		t.Fatalf("existing config lost: %s", content)
	}
	runtimes := config["runtimes"].(map[string]any)
	if _, ok := runtimes["kata"]; !ok {
		t.Fatalf("existing runtime lost: %s", content)
	}
	runsc, ok := runtimes["runsc"].(map[string]any)
	if !ok {
		t.Fatalf("runsc runtime missing: %s", content)
	}
	if runsc["path"] != "/usr/local/bin/runsc" {
		t.Fatalf("unexpected runsc path: %s", content)
	}
	runtimeArgs, ok := runsc["runtimeArgs"].([]any)
	if !ok || len(runtimeArgs) != 1 || runtimeArgs[0] != "--network=host" {
		t.Fatalf("runsc host networking missing: %s", content)
	}
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatalf("rollback mismatch: %s", restored)
	}
}

func TestWriteRunscDockerConfigRollbackRemovesNewFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "docker", "daemon.json")
	rollback, err := writeRunscDockerConfig(path, "/usr/local/bin/runsc")
	if err != nil {
		t.Fatal(err)
	}
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected config to be removed, got %v", err)
	}
}

func TestLocalDockerHost(t *testing.T) {
	for _, host := range []string{"", "unix:///var/run/docker.sock", "/var/run/docker.sock"} {
		if !isLocalDockerHost(host) {
			t.Fatalf("expected %q to be local", host)
		}
	}
	for _, host := range []string{"tcp://docker.example:2376", "ssh://host"} {
		if isLocalDockerHost(host) {
			t.Fatalf("expected %q to be remote", host)
		}
	}
}
