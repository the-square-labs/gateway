package docker

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

func builderPluginForTest(t *testing.T) *DockerPlugin {
	t.Helper()
	return &DockerPlugin{
		cfg:    &config.Config{Docker: config.DockerConfig{Mode: "builder"}},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestBuilderProfileAdvertisesOnlyBuilderDataPlaneCapabilities(t *testing.T) {
	message := builderPluginForTest(t).BuildRegisterMessage("node-1")
	joined := strings.Join(message.Capabilities, ",")
	for _, required := range []string{"docker_builder_profile_v1", "docker_registry_proxy_v1", "generic_relay_tunnel_v1"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing builder capability %s: %v", required, message.Capabilities)
		}
	}
	for _, forbidden := range []string{"docker_deployments_v1", "docker_gpu_v1", "managed_databases_v1", "proxy_secure_links_v1"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("builder advertised forbidden capability %s: %v", forbidden, message.Capabilities)
		}
	}
	if message.DockerRuntimeStatus != nil {
		t.Fatal("builder must not report the general Docker runtime manager")
	}
}

func TestBuilderProfileRejectsGeneralDockerCommandFamilies(t *testing.T) {
	plugin := builderPluginForTest(t)
	commands := []*pb.GatewayCommand{
		{CommandId: "container", Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "list"}}},
		{CommandId: "image", Payload: &pb.GatewayCommand_DockerImage{DockerImage: &pb.DockerImageCommand{Action: "list"}}},
		{CommandId: "volume", Payload: &pb.GatewayCommand_DockerVolume{DockerVolume: &pb.DockerVolumeCommand{Action: "list"}}},
		{CommandId: "network", Payload: &pb.GatewayCommand_DockerNetwork{DockerNetwork: &pb.DockerNetworkCommand{Action: "list"}}},
		{CommandId: "database", Payload: &pb.GatewayCommand_DockerDatabase{DockerDatabase: &pb.DockerDatabaseCommand{Action: "status"}}},
	}
	for _, command := range commands {
		result := plugin.HandleCommand(command)
		if result.Success || !strings.Contains(result.Error, "builder-profile daemon accepts only") {
			t.Fatalf("command %s was not rejected by builder profile: %#v", command.CommandId, result)
		}
	}
}

func TestBuilderProfileRecognizesOnlyBuildCommandFamily(t *testing.T) {
	plugin := builderPluginForTest(t)
	for _, test := range []struct {
		command *pb.GatewayCommand
		error   string
	}{
		{command: &pb.GatewayCommand{CommandId: "build", Payload: &pb.GatewayCommand_DockerBuild{DockerBuild: &pb.DockerBuildCommand{BuildId: "build-1"}}}, error: "builder execution is not initialized"},
		{command: &pb.GatewayCommand{CommandId: "cancel", Payload: &pb.GatewayCommand_DockerBuildCancel{DockerBuildCancel: &pb.DockerBuildCancelCommand{BuildId: "build-1"}}}, error: "build is not running"},
		{command: &pb.GatewayCommand{CommandId: "ack", Payload: &pb.GatewayCommand_DockerBuildEventAck{DockerBuildEventAck: &pb.DockerBuildEventAck{BuildId: "build-1", Attempt: 1}}}, error: "builder execution is not initialized"},
	} {
		command := test.command
		result := plugin.HandleCommand(command)
		if result.Success || result.Error != test.error {
			t.Fatalf("builder command family was not isolated for T9 implementation: %#v", result)
		}
	}
}
