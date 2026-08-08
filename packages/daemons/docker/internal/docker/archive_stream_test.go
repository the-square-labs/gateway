package docker

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"testing"

	"github.com/moby/moby/api/types/container"
)

func TestValidateGwcaExportSupportAllowsDockerDefaults(t *testing.T) {
	config := &container.Config{}
	host := &container.HostConfig{Runtime: "runc", ShmSize: 64 * 1024 * 1024}
	if err := validateGwcaExportSupport(config, host); err != nil {
		t.Fatalf("ordinary Docker defaults rejected: %v", err)
	}
}

func TestValidateGwcaExportSupportRejectsUnsupportedSettings(t *testing.T) {
	tests := []*container.HostConfig{
		{Privileged: true},
		{CapAdd: []string{"SYS_ADMIN"}},
		{NetworkMode: "host"},
		{ReadonlyRootfs: true},
		{Runtime: "nvidia"},
		{ShmSize: 128 * 1024 * 1024},
	}
	for index, host := range tests {
		if err := validateGwcaExportSupport(&container.Config{}, host); err == nil {
			t.Fatalf("unsupported configuration %d was accepted", index)
		}
	}
}

func TestStripArchiveSecretEnvRemovesOnlyManagedSecrets(t *testing.T) {
	got := stripArchiveSecretEnv(
		[]string{"PUBLIC_VALUE=visible", "DATABASE_PASSWORD=secret", "EMPTY_SECRET=", "NO_EQUALS"},
		[]string{"DATABASE_PASSWORD", "EMPTY_SECRET"},
	)
	want := []string{"PUBLIC_VALUE=visible", "NO_EQUALS"}
	if len(got) != len(want) {
		t.Fatalf("filtered environment = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("filtered environment = %#v, want %#v", got, want)
		}
	}
}

func TestArchiveCommitEnvironmentUsesBaseImageEnvWhenRuntimeEnvironmentIsExcluded(t *testing.T) {
	got := archiveCommitEnvironment(
		false,
		false,
		[]string{"PATH=/runtime", "DATABASE_PASSWORD=secret", "RUNTIME_ONLY=value"},
		[]string{"PATH=/image", "LANG=C"},
		[]string{"DATABASE_PASSWORD"},
	)
	want := []string{"PATH=/image", "LANG=C"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commit environment = %#v, want %#v", got, want)
	}
}

func TestStripDockerArchiveRepoTagsRemovesAllTagMetadata(t *testing.T) {
	var source bytes.Buffer
	writer := tar.NewWriter(&source)
	manifest, err := json.Marshal([]map[string]any{{
		"Config":   "config.json",
		"RepoTags": []string{"registry.example/app:stable", "registry.example/app:previous"},
		"Layers":   []string{"layer.tar"},
	}})
	if err != nil {
		t.Fatalf("marshal image manifest: %v", err)
	}
	for _, entry := range []struct {
		name string
		data []byte
	}{
		{name: "manifest.json", data: manifest},
		{name: "repositories", data: []byte(`{"registry.example":{"app":"sha256:poisoned"}}`)},
		{name: "layer.tar", data: []byte("layer contents")},
	} {
		if err := writer.WriteHeader(&tar.Header{Name: entry.name, Mode: 0o600, Size: int64(len(entry.data))}); err != nil {
			t.Fatalf("write %s header: %v", entry.name, err)
		}
		if _, err := writer.Write(entry.data); err != nil {
			t.Fatalf("write %s: %v", entry.name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close source archive: %v", err)
	}

	var sanitized bytes.Buffer
	if err := stripDockerArchiveRepoTags(bytes.NewReader(source.Bytes()), &sanitized); err != nil {
		t.Fatalf("strip archive tags: %v", err)
	}

	entries := map[string][]byte{}
	reader := tar.NewReader(bytes.NewReader(sanitized.Bytes()))
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read sanitized archive: %v", err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read sanitized entry %s: %v", header.Name, err)
		}
		entries[header.Name] = content
	}

	var rewritten []struct {
		RepoTags []string `json:"RepoTags"`
	}
	if err := json.Unmarshal(entries["manifest.json"], &rewritten); err != nil {
		t.Fatalf("parse sanitized image manifest: %v", err)
	}
	if len(rewritten) != 1 || len(rewritten[0].RepoTags) != 0 {
		t.Fatalf("sanitized RepoTags = %#v, want empty", rewritten)
	}
	if got := string(entries["repositories"]); got != "{}" {
		t.Fatalf("sanitized repositories = %q, want empty object", got)
	}
	if got := string(entries["layer.tar"]); got != "layer contents" {
		t.Fatalf("layer contents = %q", got)
	}
}

func TestStripDockerArchiveRepoTagsRejectsMetadataPathAliasesAndDuplicates(t *testing.T) {
	for _, entries := range [][]string{
		{"/manifest.json"},
		{"/../manifest.json"},
		{"./manifest.json"},
		{"//repositories"},
		{"../../repositories"},
		{"nested/../repositories"},
		{"manifest.json", "manifest.json"},
		{"repositories", "repositories"},
	} {
		t.Run(entries[0], func(t *testing.T) {
			var source bytes.Buffer
			writer := tar.NewWriter(&source)
			for _, name := range entries {
				if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: 2}); err != nil {
					t.Fatalf("write %s header: %v", name, err)
				}
				if _, err := writer.Write([]byte("{}")); err != nil {
					t.Fatalf("write %s: %v", name, err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatalf("close source archive: %v", err)
			}

			var sanitized bytes.Buffer
			if err := stripDockerArchiveRepoTags(bytes.NewReader(source.Bytes()), &sanitized); err == nil {
				t.Fatalf("strip archive tags accepted metadata entries %#v", entries)
			}
		})
	}
}

func TestStripDockerArchiveRepoTagsRejectsNonRegularMetadata(t *testing.T) {
	var source bytes.Buffer
	writer := tar.NewWriter(&source)
	if err := writer.WriteHeader(&tar.Header{Name: "manifest.json", Typeflag: tar.TypeSymlink, Linkname: "payload.json"}); err != nil {
		t.Fatalf("write symlink header: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close source archive: %v", err)
	}

	var sanitized bytes.Buffer
	if err := stripDockerArchiveRepoTags(bytes.NewReader(source.Bytes()), &sanitized); err == nil {
		t.Fatal("strip archive tags accepted a non-regular manifest entry")
	}
}

func TestSanitizeGwcaLabelsRemovesReservedOwnershipNamespaces(t *testing.T) {
	got := sanitizeGwcaLabels(map[string]string{
		"app.label":                          "kept",
		"com.docker.compose.project":         "compose",
		"wiolett.gateway.archive.id":         "archive",
		"wiolett.gateway.deployment.managed": "true",
		"wiolett.gateway.migration.id":       "migration",
	})
	if len(got) != 1 || got["app.label"] != "kept" {
		t.Fatalf("reserved labels survived sanitization: %#v", got)
	}
}

func TestIntroducedArchiveImageIDsReturnsOnlyNewImages(t *testing.T) {
	got := introducedArchiveImageIDs(
		map[string]struct{}{"sha256:existing": {}},
		map[string]struct{}{"sha256:existing": {}, "sha256:new-b": {}, "sha256:new-a": {}},
	)
	want := []string{"sha256:new-a", "sha256:new-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected introduced image IDs: got %#v want %#v", got, want)
	}
}

func TestGwcaManifestToMigrationBuildsSupportedCreateRequest(t *testing.T) {
	manifest := gwcaContainerManifest{
		SchemaVersion:  1,
		ImageReference: "registry.example/app:stable",
		Entrypoint:     []string{"/entrypoint"},
		Command:        []string{"serve"},
		Environment:    map[string]string{"PUBLIC_VALUE": "visible"},
		Secrets:        map[string]string{"DATABASE_PASSWORD": "secret"},
		Ports:          []gwcaPortMapping{{ContainerPort: 8080, HostPort: 18080, Protocol: "tcp"}},
		Mounts:         []gwcaMount{{Type: "bind", Source: "/srv/app", Target: "/app", ReadOnly: true}},
		Networks:       []gwcaNetwork{{Name: "application", Driver: "bridge", Createable: true}},
		RestartPolicy:  "unless-stopped",
		Resources:      gwcaResources{MemoryLimit: 256 * 1024 * 1024, NanoCPUs: 500_000_000},
	}
	request, err := gwcaManifestToMigration(
		manifest,
		"sha256:"+repeatHex("a"),
		"registry.example/app:stable",
		"restored-app",
		"archive-1",
	)
	if err != nil {
		t.Fatalf("convert manifest: %v", err)
	}
	if request.Manifest.Name != "restored-app" || request.Manifest.Config.Image != "registry.example/app:stable" {
		t.Fatalf("unexpected create manifest: %#v", request.Manifest)
	}
	if len(request.Env) != 2 || request.Env[0] != "DATABASE_PASSWORD=secret" || request.Env[1] != "PUBLIC_VALUE=visible" {
		t.Fatalf("environment = %#v", request.Env)
	}
	if got := request.Manifest.HostConfig.Binds; len(got) != 1 || got[0] != "/srv/app:/app:ro" {
		t.Fatalf("binds = %#v", got)
	}
	if request.Manifest.HostConfig.NetworkMode != "application" {
		t.Fatalf("network mode = %q", request.Manifest.HostConfig.NetworkMode)
	}
	if request.Manifest.HostConfig.Memory != 256*1024*1024 || request.Manifest.HostConfig.NanoCPUs != 500_000_000 {
		t.Fatalf("resources were not preserved: %#v", request.Manifest.HostConfig.Resources)
	}
}

func TestGwcaManifestToMigrationRejectsDuplicateSecretKey(t *testing.T) {
	_, err := gwcaManifestToMigration(
		gwcaContainerManifest{
			SchemaVersion: 1,
			Environment:   map[string]string{"TOKEN": "public"},
			Secrets:       map[string]string{"TOKEN": "secret"},
		},
		"sha256:"+repeatHex("a"),
		"sha256:"+repeatHex("a"),
		"restored-app",
		"archive-1",
	)
	if err == nil {
		t.Fatal("duplicate environment and secret key was accepted")
	}
}

func TestGwcaPortConflictsAreProtocolAware(t *testing.T) {
	manifest := gwcaContainerManifest{Ports: []gwcaPortMapping{
		{ContainerPort: 8080, HostPort: 18080, Protocol: "tcp"},
		{ContainerPort: 8080, HostPort: 18080, Protocol: "udp"},
		{ContainerPort: 9090, HostPort: 19090, Protocol: "tcp"},
	}}
	containers := []ContainerInfo{{Ports: []PortInfo{
		{PublicPort: 18080, Type: "tcp"},
		{PublicPort: 19090, Type: "udp"},
	}}}
	want := []string{"8080/tcp:18080"}
	if got := gwcaPortConflicts(manifest, containers); !reflect.DeepEqual(got, want) {
		t.Fatalf("port conflicts = %#v, want %#v", got, want)
	}
}

func TestGwcaPortConflictsRejectDuplicateArchiveBindings(t *testing.T) {
	manifest := gwcaContainerManifest{Ports: []gwcaPortMapping{
		{ContainerPort: 8080, HostPort: 18080, Protocol: "tcp"},
		{ContainerPort: 8081, HostPort: 18080, Protocol: "tcp"},
		{ContainerPort: 8082, HostPort: 0, Protocol: "tcp"},
	}}
	want := []string{"8080/tcp:18080", "8081/tcp:18080"}
	if got := gwcaPortConflicts(manifest, nil); !reflect.DeepEqual(got, want) {
		t.Fatalf("port conflicts = %#v, want %#v", got, want)
	}
}

func TestSelectArchivePullReferencePrefersOriginalRepository(t *testing.T) {
	got := selectArchivePullReference("registry.example/team/app:stable", []string{
		"mirror.example/team/app@sha256:" + repeatHex("a"),
		"registry.example/team/app@sha256:" + repeatHex("b"),
	})
	want := "registry.example/team/app@sha256:" + repeatHex("b")
	if got != want {
		t.Fatalf("pull reference = %q, want %q", got, want)
	}
}

func TestSelectArchivePullReferenceRequiresDigest(t *testing.T) {
	if got := selectArchivePullReference("example/app:latest", []string{"example/app:latest"}); got != "" {
		t.Fatalf("pull reference = %q, want empty", got)
	}
}

func TestConfiguredArchiveImageReferencePrefersPreservedRegistryReference(t *testing.T) {
	got := configuredArchiveImageReference("sha256:"+repeatHex("a"), map[string]string{
		archiveImageReferenceLabel: "registry.example/team/app:stable",
	})
	if got != "registry.example/team/app:stable" {
		t.Fatalf("image reference = %q", got)
	}
}

func TestPrepareArchiveCreateImageReferenceKeepsTagOnlyAsMetadata(t *testing.T) {
	imageID := "sha256:" + repeatHex("a")
	createImage, preservedReference := (&DockerPlugin{}).prepareArchiveCreateImageReference(
		imageID,
		"registry.example/team/app:stable",
	)
	if createImage != imageID {
		t.Fatalf("create image = %q, want immutable image ID %q", createImage, imageID)
	}
	if preservedReference != "registry.example/team/app:stable" {
		t.Fatalf("preserved image reference = %q", preservedReference)
	}
	config := &container.Config{Labels: sanitizeGwcaLabels(map[string]string{
		archiveImageReferenceLabel: "registry.example/attacker/image:poisoned",
	})}
	setArchiveImageReferenceLabel(config, preservedReference)
	if got := configuredArchiveImageReference(createImage, config.Labels); got != preservedReference {
		t.Fatalf("update image reference = %q, want %q", got, preservedReference)
	}
}

func repeatHex(value string) string {
	result := ""
	for range 64 {
		result += value
	}
	return result
}
