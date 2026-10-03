package docker

import (
	"strings"
	"testing"
)

func TestVolumeDataAccessNeedsRoot(t *testing.T) {
	previous := daemonEUID
	t.Cleanup(func() { daemonEUID = previous })

	daemonEUID = func() int { return 0 }
	if err := requireVolumeDataAccess("exporting a volume for migration"); err != nil {
		t.Fatalf("root daemon refused volume data access: %v", err)
	}

	daemonEUID = func() int { return 4242 }
	err := requireVolumeDataAccess("exporting a volume for migration")
	if err == nil {
		t.Fatal("non-root daemon was allowed to read volume data")
	}
	for _, want := range []string{"exporting a volume for migration", "needs docker-daemon to run as root", "uid 4242"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name %q", err, want)
		}
	}
}

func TestNonRootCapabilitiesDropRootOnlyFeatures(t *testing.T) {
	values := []string{"docker_deployments_v1", "proxy_secure_links_v1", "docker_registry_proxy_v1", managedStorageLinkCapability, managedLinkRuntimeCapability}
	got := withoutRootOnlyCapabilities(values)
	want := []string{"docker_deployments_v1", "docker_registry_proxy_v1", managedLinkRuntimeCapability}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("capabilities = %v, want %v", got, want)
	}
	if values[1] != "proxy_secure_links_v1" {
		t.Fatal("the input list was modified")
	}
}
