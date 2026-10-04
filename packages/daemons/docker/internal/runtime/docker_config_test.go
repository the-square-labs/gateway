package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const testRunscPath = "/usr/local/bin/runsc"

func writeTestDockerConfig(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "daemon.json")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func TestRunscRegistrationKeepsTheOperatorDaemonJSONByteForByte(t *testing.T) {
	original := "{\n    \"log-driver\": \"json-file\",\n    \"log-opts\": {\"max-size\": \"10m\", \"max-file\": \"3\"},\n    \"max-concurrent-downloads\": 12345678901234567890,\n    \"dns\": [ \"10.0.0.53\" ]\n}\n"
	path := writeTestDockerConfig(t, original, 0o600)

	rollback, err := writeRunscDockerConfig(path, testRunscPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n    \"log-driver\": \"json-file\",\n    \"log-opts\": {\"max-size\": \"10m\", \"max-file\": \"3\"},\n    \"max-concurrent-downloads\": 12345678901234567890,\n    \"dns\": [ \"10.0.0.53\" ],\n    \"runtimes\": {\n        \"runsc\": {\n            \"path\": \"/usr/local/bin/runsc\",\n            \"runtimeArgs\": [\n                \"--network=host\"\n            ]\n        }\n    }\n}\n"
	if got := readTestFile(t, path); got != want {
		t.Fatalf("daemon.json =\n%s\nwant\n%s", got, want)
	}
	if got := readTestFile(t, path+dockerConfigBackupSuffix); got != original {
		t.Fatalf("backup = %q, want the original %q", got, original)
	}
	for _, file := range []string{path, path + dockerConfigBackupSuffix} {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %v, want the original 0600", file, info.Mode().Perm())
		}
	}

	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	if got := readTestFile(t, path); got != original {
		t.Fatalf("rolled back daemon.json = %q, want %q", got, original)
	}
	if _, err := os.Stat(path + dockerConfigBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("rollback kept the backup it created: %v", err)
	}
}

func TestRunscRegistrationDoesNotWriteACurrentDaemonJSON(t *testing.T) {
	original := "{\"runtimes\":{\"runsc\":{\"path\":\"/usr/local/bin/runsc\",\"runtimeArgs\":[\"--platform=systrap\",\"--network=host\"]}},\"log-level\":\"warn\"}"
	path := writeTestDockerConfig(t, original, 0o644)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	rollback, err := writeRunscDockerConfig(path, testRunscPath)
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) || readTestFile(t, path) != original {
		t.Fatal("a daemon.json that already registers runsc was rewritten")
	}
	if _, err := os.Stat(path + dockerConfigBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("an unchanged daemon.json got a backup: %v", err)
	}
	if err := rollback(); err != nil || readTestFile(t, path) != original {
		t.Fatalf("rollback of an unchanged daemon.json changed it: %v", err)
	}
}

func TestRunscRegistrationReplacesOnlyTheRunscValue(t *testing.T) {
	original := "{\n  \"runtimes\": {\n    \"nvidia\": {\"path\": \"nvidia-container-runtime\", \"runtimeArgs\": []},\n    \"runsc\": {\n      \"path\": \"/opt/old/runsc\",\n      \"runtimeArgs\": [\"--platform=systrap\"]\n    }\n  },\n  \"debug\": true\n}\n"
	path := writeTestDockerConfig(t, original, 0o644)

	if _, err := writeRunscDockerConfig(path, testRunscPath); err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"runtimes\": {\n    \"nvidia\": {\"path\": \"nvidia-container-runtime\", \"runtimeArgs\": []},\n    \"runsc\": {\n      \"path\": \"/usr/local/bin/runsc\",\n      \"runtimeArgs\": [\n        \"--platform=systrap\",\n        \"--network=host\"\n      ]\n    }\n  },\n  \"debug\": true\n}\n"
	if got := readTestFile(t, path); got != want {
		t.Fatalf("daemon.json =\n%s\nwant\n%s", got, want)
	}
}

func TestRunscRegistrationAddsRunscToExistingRuntimes(t *testing.T) {
	cases := map[string]struct{ original, want string }{
		"other runtime": {
			original: "{\n\t\"runtimes\": {\n\t\t\"nvidia\": {\"path\": \"nvidia-container-runtime\"}\n\t}\n}\n",
			want:     "{\n\t\"runtimes\": {\n\t\t\"nvidia\": {\"path\": \"nvidia-container-runtime\"},\n\t\t\"runsc\": {\n\t\t\t\"path\": \"/usr/local/bin/runsc\",\n\t\t\t\"runtimeArgs\": [\n\t\t\t\t\"--network=host\"\n\t\t\t]\n\t\t}\n\t}\n}\n",
		},
		"empty runtimes": {
			original: "{\n  \"runtimes\": {},\n  \"debug\": true\n}\n",
			want:     "{\n  \"runtimes\": {\n    \"runsc\": {\n      \"path\": \"/usr/local/bin/runsc\",\n      \"runtimeArgs\": [\n        \"--network=host\"\n      ]\n    }\n  },\n  \"debug\": true\n}\n",
		},
		"one line": {
			original: "{\"log-driver\": \"local\"}",
			want:     "{\"log-driver\": \"local\",\"runtimes\": {\"runsc\":{\"path\":\"/usr/local/bin/runsc\",\"runtimeArgs\":[\"--network=host\"]}}}",
		},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeTestDockerConfig(t, test.original, 0o644)
			if _, err := writeRunscDockerConfig(path, testRunscPath); err != nil {
				t.Fatal(err)
			}
			if got := readTestFile(t, path); got != test.want {
				t.Fatalf("daemon.json =\n%s\nwant\n%s", got, test.want)
			}
		})
	}
}

func TestRunscRegistrationBacksUpTheOperatorFileOnlyOnce(t *testing.T) {
	original := "{\"log-driver\": \"local\"}\n"
	path := writeTestDockerConfig(t, original, 0o644)
	if _, err := writeRunscDockerConfig(path, testRunscPath); err != nil {
		t.Fatal(err)
	}
	if _, err := writeRunscDockerConfig(path, "/opt/gvisor/runsc"); err != nil {
		t.Fatal(err)
	}
	if got := readTestFile(t, path+dockerConfigBackupSuffix); got != original {
		t.Fatalf("backup = %q, want the operator's first file %q", got, original)
	}
	registered, current, err := runscDockerConfigStatus(path, "/opt/gvisor/runsc")
	if err != nil || !registered || !current {
		t.Fatalf("runsc status = %v %v %v after the second change", registered, current, err)
	}
}

func TestRunscRegistrationCreatesAMissingDaemonJSONWithoutBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "docker", "daemon.json")
	rollback, err := writeRunscDockerConfig(path, testRunscPath)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]map[string]runscDockerRuntime
	if err := json.Unmarshal([]byte(readTestFile(t, path)), &config); err != nil {
		t.Fatal(err)
	}
	if runsc := config["runtimes"]["runsc"]; runsc.Path != testRunscPath || len(runsc.RuntimeArgs) != 1 || runsc.RuntimeArgs[0] != "--network=host" {
		t.Fatalf("new daemon.json runsc = %+v", runsc)
	}
	if _, err := os.Stat(path + dockerConfigBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("a new daemon.json got a backup: %v", err)
	}
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("rollback kept the daemon.json it created: %v", err)
	}
}

func TestRunscRegistrationRefusesAnInvalidDaemonJSON(t *testing.T) {
	original := "{\"log-driver\": \"local\",}\n"
	path := writeTestDockerConfig(t, original, 0o644)
	if _, err := writeRunscDockerConfig(path, testRunscPath); err == nil {
		t.Fatal("an invalid daemon.json was accepted")
	}
	if readTestFile(t, path) != original {
		t.Fatal("an invalid daemon.json was changed")
	}
	if _, err := os.Stat(path + dockerConfigBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("an invalid daemon.json got a backup: %v", err)
	}
}
