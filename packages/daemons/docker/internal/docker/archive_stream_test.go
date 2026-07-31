package docker

import (
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

func repeatHex(value string) string {
	result := ""
	for range 64 {
		result += value
	}
	return result
}
