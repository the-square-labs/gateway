package daemon

import (
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const registryIngressTestID = "00000000-0000-4000-8000-000000000002"

func validRegistryIngressBinding() *pb.DockerRegistryBinding {
	return &pb.DockerRegistryBinding{
		BindingId:                  registryIngressTestID,
		Role:                       "ingress",
		Generation:                 1,
		Repository:                 "*",
		Actions:                    []string{"pull", "push"},
		LocalAddress:               "127.0.0.1",
		LocalPort:                  registryIngressPort,
		RelayOwnerKind:             registrySecureLinkOwnerKind,
		RelayOwnerId:               registryIngressTestID,
		Authorization:              "",
		AuthorizationExpiresAtUnix: 0,
	}
}

func TestRegistryIngressCommandAcceptsOnlyBlindLoopbackBinding(t *testing.T) {
	converted, err := registryIngressCommand(&pb.SyncDockerRegistryBindingsCommand{
		Bindings: []*pb.DockerRegistryBinding{validRegistryIngressBinding()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(converted.Bindings) != 1 || converted.Bindings[0].GetRole() != "source" || converted.Bindings[0].GetListenerPort() != registryIngressPort {
		t.Fatalf("unexpected converted binding: %#v", converted.Bindings)
	}
}

func TestRegistryIngressCommandRejectsInjectedAuthorizationAndWrongOwner(t *testing.T) {
	injected := validRegistryIngressBinding()
	injected.Authorization = "Bearer secret"
	if _, err := registryIngressCommand(&pb.SyncDockerRegistryBindingsCommand{Bindings: []*pb.DockerRegistryBinding{injected}}); err == nil {
		t.Fatal("expected injected authorization to be rejected")
	}

	wrongOwner := validRegistryIngressBinding()
	wrongOwner.RelayOwnerKind = "registry_secure_link"
	if _, err := registryIngressCommand(&pb.SyncDockerRegistryBindingsCommand{Bindings: []*pb.DockerRegistryBinding{wrongOwner}}); err == nil {
		t.Fatal("expected wrong relay owner to be rejected")
	}
}

func TestRegistryIngressCommandRejectsRepositoryScopingAtTransportLayer(t *testing.T) {
	binding := validRegistryIngressBinding()
	binding.Repository = "tenant/app"
	if _, err := registryIngressCommand(&pb.SyncDockerRegistryBindingsCommand{Bindings: []*pb.DockerRegistryBinding{binding}}); err == nil {
		t.Fatal("expected repository-scoped ingress binding to be rejected")
	}
}
