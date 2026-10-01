package docker

import (
	"testing"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

func TestDockerProfileAdvertisesStorageLinkCapability(t *testing.T) {
	plugin := &DockerPlugin{cfg: &config.Config{}}
	if !containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedStorageLinkCapability) {
		t.Fatal("docker profile does not advertise that it hosts managed storage links")
	}
	plugin.cfg.Docker.Mode = "storage"
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedStorageLinkCapability) {
		t.Fatal("storage profile advertised the managed storage link capability")
	}
}
