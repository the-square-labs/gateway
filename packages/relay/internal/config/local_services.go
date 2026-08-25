package config

import "fmt"

const (
	RegistryServiceID     = "gateway-internal-registry"
	RegistryServiceTarget = "registry:5000"
)

type LocalServiceTarget struct {
	ID     string
	Target string
}

// BuiltinLocalServiceTarget returns an immutable relay-owned destination.
// Callers cannot supply a host or port, which prevents policy metadata from
// turning the local Relay into an arbitrary network dialer.
func BuiltinLocalServiceTarget(id string) (LocalServiceTarget, error) {
	if id != RegistryServiceID {
		return LocalServiceTarget{}, fmt.Errorf("unknown built-in local service %q", id)
	}
	return LocalServiceTarget{ID: RegistryServiceID, Target: RegistryServiceTarget}, nil
}
