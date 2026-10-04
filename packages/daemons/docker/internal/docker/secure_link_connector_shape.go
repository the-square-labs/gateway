package docker

import (
	"context"
	"fmt"
	"sync"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
)

// The shared connector carries every link of the node (proxy secure links, container links, managed storage and
// database links): it gets 10% of the host's memory within [256 MiB, 1 GiB], no CPU limit, and room for the
// goroutines of many sessions (D6). The connector keeps its Go memory limit at 90% of its cgroup's limit itself, so a
// new memory limit is applied in place (ContainerUpdate) and never replaces the connector.
const (
	secureLinkConnectorMinMemory = 256 * 1024 * 1024
	secureLinkConnectorMaxMemory = 1024 * 1024 * 1024
	secureLinkConnectorNanoCPUs  = 0
	secureLinkConnectorPidsLimit = int64(1024)

	// The shape of the connectors of earlier releases. A connector of that shape is still the node's own (it is
	// replaced next to the serving one, removed on teardown), but no longer valid for a sync.
	legacySecureLinkConnectorMemory    = 128 * 1024 * 1024
	legacySecureLinkConnectorNanoCPUs  = 250_000_000
	legacySecureLinkConnectorPidsLimit = int64(128)
)

// hostMemoryBytes is the host's memory, read once per process (a variable for tests).
var hostMemoryBytes = sync.OnceValue(func() int64 { return sysmetrics.GetSystemMemory().TotalBytes })

// secureLinkConnectorMemory is the connector's memory limit: 10% of the host's memory, in whole MiB, within
// [256 MiB, 1 GiB].
func secureLinkConnectorMemory() int64 {
	const mebibyte = 1024 * 1024
	memory := hostMemoryBytes() / 10 / mebibyte * mebibyte
	return min(max(memory, secureLinkConnectorMinMemory), secureLinkConnectorMaxMemory)
}

// secureLinkConnectorEnv is the environment of the connector in slot.
func secureLinkConnectorEnv(slot int) []string {
	return []string{secureLinkConnectorSocketEnv(slot)}
}

func secureLinkConnectorResources() container.Resources {
	pids := secureLinkConnectorPidsLimit
	return container.Resources{Memory: secureLinkConnectorMemory(), NanoCPUs: secureLinkConnectorNanoCPUs, PidsLimit: &pids}
}

// currentSecureLinkConnectorShape reports a connector with this release's limits and environment. Any memory limit
// within the clamp is current: the host's memory read at another start must not replace the connector.
func currentSecureLinkConnectorShape(inspect container.InspectResponse) bool {
	config, host := inspect.Config, inspect.HostConfig
	slot, named := connectorSlot(inspect)
	if !named || config == nil || host == nil {
		return false
	}
	return host.Resources.Memory >= secureLinkConnectorMinMemory && host.Resources.Memory <= secureLinkConnectorMaxMemory &&
		host.Resources.NanoCPUs == secureLinkConnectorNanoCPUs &&
		host.Resources.PidsLimit != nil && *host.Resources.PidsLimit == secureLinkConnectorPidsLimit &&
		validSecureLinkConnectorEnv(config.Env, secureLinkConnectorSocketEnv(slot))
}

// legacySecureLinkConnectorShape reports a connector of an earlier release's limits and environment.
func legacySecureLinkConnectorShape(inspect container.InspectResponse) bool {
	config, host := inspect.Config, inspect.HostConfig
	slot, named := connectorSlot(inspect)
	if !named || config == nil || host == nil {
		return false
	}
	return host.Resources.Memory == legacySecureLinkConnectorMemory && host.Resources.NanoCPUs == legacySecureLinkConnectorNanoCPUs &&
		host.Resources.PidsLimit != nil && *host.Resources.PidsLimit == legacySecureLinkConnectorPidsLimit &&
		validSecureLinkConnectorEnv(config.Env, secureLinkConnectorSocketEnv(slot))
}

// validSecureLinkConnectorEnv accepts exactly the socket variable and the image's PATH, each once.
func validSecureLinkConnectorEnv(values []string, socket string) bool {
	seenSocket, seenPath := false, false
	for _, value := range values {
		switch {
		case value == socket && !seenSocket:
			seenSocket = true
		case value == secureLinkConnectorPathEnv && !seenPath:
			seenPath = true
		default:
			return false
		}
	}
	return seenSocket
}

// updateConnectorMemory sets the memory limit of a current connector in place when the host's memory gives another
// one; the connector follows it with its Go memory limit.
func (m *dockerSecureLinkManager) updateConnectorMemory(ctx context.Context, inspect container.InspectResponse) error {
	want := secureLinkConnectorMemory()
	if inspect.HostConfig == nil || inspect.HostConfig.Resources.Memory == want {
		return nil
	}
	// Docker's default swap for a memory limit is the same amount again.
	if _, err := m.plugin.client.cli.ContainerUpdate(ctx, inspect.ID, mobyclient.ContainerUpdateOptions{
		Resources: &container.Resources{Memory: want, MemorySwap: 2 * want},
	}); err != nil {
		return fmt.Errorf("update secure-link connector memory: %w", err)
	}
	return nil
}
