package docker

import (
	"strconv"
	"sync"

	"github.com/moby/moby/api/types/container"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
)

// The shared connector carries every link of the node (proxy secure links, container links, managed storage and
// database links): it gets 10% of the host's memory within [256 MiB, 1 GiB], a Go memory limit at 90% of that so the
// runtime collects before the kernel kills, no CPU limit, and room for the goroutines of many sessions (D6).
const (
	secureLinkConnectorMinMemory = 256 * 1024 * 1024
	secureLinkConnectorMaxMemory = 1024 * 1024 * 1024
	secureLinkConnectorNanoCPUs  = 0
	secureLinkConnectorPidsLimit = int64(1024)
	secureLinkConnectorGoMemEnv  = "GOMEMLIMIT="

	// The shape of the connectors of earlier releases. A connector of that shape is still the node's own (it is
	// replaced next to the serving one, removed on teardown), but no longer valid for a sync.
	legacySecureLinkConnectorMemory    = 128 * 1024 * 1024
	legacySecureLinkConnectorNanoCPUs  = 250_000_000
	legacySecureLinkConnectorPidsLimit = int64(128)
)

// hostMemoryBytes is the host's memory, read once per process: the connector's memory must stay the same from one
// sync to the next, or every sync would find the connector outdated. A variable for tests.
var hostMemoryBytes = sync.OnceValue(func() int64 { return sysmetrics.GetSystemMemory().TotalBytes })

// secureLinkConnectorMemory is the connector's memory limit: 10% of the host's memory, in whole MiB, within
// [256 MiB, 1 GiB].
func secureLinkConnectorMemory() int64 {
	const mebibyte = 1024 * 1024
	memory := hostMemoryBytes() / 10 / mebibyte * mebibyte
	return min(max(memory, secureLinkConnectorMinMemory), secureLinkConnectorMaxMemory)
}

// secureLinkConnectorGoMemLimitEnv is the connector's GOMEMLIMIT: 90% of its memory limit, in bytes.
func secureLinkConnectorGoMemLimitEnv() string {
	return secureLinkConnectorGoMemEnv + strconv.FormatInt(secureLinkConnectorMemory()/10*9, 10)
}

// secureLinkConnectorEnv is the environment of the connector in slot.
func secureLinkConnectorEnv(slot int) []string {
	return []string{secureLinkConnectorSocketEnv(slot), secureLinkConnectorGoMemLimitEnv()}
}

func secureLinkConnectorResources() container.Resources {
	pids := secureLinkConnectorPidsLimit
	return container.Resources{Memory: secureLinkConnectorMemory(), NanoCPUs: secureLinkConnectorNanoCPUs, PidsLimit: &pids}
}

// currentSecureLinkConnectorShape reports a connector with this release's limits and environment.
func currentSecureLinkConnectorShape(inspect container.InspectResponse) bool {
	config, host := inspect.Config, inspect.HostConfig
	slot, named := connectorSlot(inspect)
	if !named || config == nil || host == nil {
		return false
	}
	return host.Resources.Memory == secureLinkConnectorMemory() && host.Resources.NanoCPUs == secureLinkConnectorNanoCPUs &&
		host.Resources.PidsLimit != nil && *host.Resources.PidsLimit == secureLinkConnectorPidsLimit &&
		validSecureLinkConnectorEnv(config.Env, secureLinkConnectorSocketEnv(slot), secureLinkConnectorGoMemLimitEnv())
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
		validSecureLinkConnectorEnv(config.Env, secureLinkConnectorSocketEnv(slot), "")
}

// validSecureLinkConnectorEnv accepts exactly the socket variable, the Go memory limit memLimit (none when empty) and
// the image's PATH, each once.
func validSecureLinkConnectorEnv(values []string, socket, memLimit string) bool {
	seenSocket, seenPath, seenMemLimit := false, false, false
	for _, value := range values {
		switch {
		case value == socket && !seenSocket:
			seenSocket = true
		case value == secureLinkConnectorPathEnv && !seenPath:
			seenPath = true
		case memLimit != "" && value == memLimit && !seenMemLimit:
			seenMemLimit = true
		default:
			return false
		}
	}
	return seenSocket && seenMemLimit == (memLimit != "")
}
