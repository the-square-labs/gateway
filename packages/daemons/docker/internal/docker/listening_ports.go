package docker

import (
	"context"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/client"
)

// Listening TCP ports of running containers, read from the host's view of each
// container's network namespace (/proc/<pid>/net/tcp and tcp6). An image that
// does not EXPOSE its port still gets a port suggestion from what its process
// actually listens on. gVisor runs with --network=host, so a gVisor container's
// sockets are kernel sockets in its namespace and show up the same way.
//
// The kernel walks its whole socket hash for every read (about 20 ms on a large
// host), so results are cached per container start: a container is read once
// when first listed, and stale results are refreshed in the background.

const (
	maxListeningPorts = 64
	// A container whose namespace could not be read is inspected again after this long.
	listeningPortRecheckAfter   = time.Minute
	listeningPortInspectTimeout = 2 * time.Second
	listeningPortReadWorkers    = 4
	listeningPortTTL            = time.Minute
	// A container that has just started may not listen yet, so an empty result is re-read sooner.
	listeningPortStartupTTL    = 5 * time.Second
	listeningPortStartupWindow = 2 * time.Minute
)

var listeningPortProcRoot = "/proc"

type listeningPortCache struct {
	mu         sync.Mutex
	entries    map[string]*listeningPortTarget
	refreshing bool
}

type listeningPortTarget struct {
	pid       int
	usable    bool
	checkedAt time.Time
	// ports stays nil until the namespace was read successfully.
	ports  []uint16
	readAt time.Time
}

func (t *listeningPortTarget) stale(now time.Time) bool {
	ttl := listeningPortTTL
	if len(t.ports) == 0 && now.Sub(t.checkedAt) < listeningPortStartupWindow {
		ttl = listeningPortStartupTTL
	}
	return now.Sub(t.readAt) >= ttl
}

// AttachListeningPorts fills ListeningPorts of running containers. It stays nil
// (unknown) for stopped and host-network containers and wherever the namespace
// cannot be read; callers then fall back to the declared ports.
func (c *Client) AttachListeningPorts(ctx context.Context, containers []ContainerInfo) {
	cache := &c.listeningPorts
	now := time.Now()
	live := make(map[string]struct{}, len(containers))
	var cold, stale []string
	for i := range containers {
		ctr := &containers[i]
		if ctr.State != "running" {
			continue
		}
		live[ctr.ID] = struct{}{}
		if !c.listeningPortTarget(ctx, ctr.ID) {
			continue
		}
		cache.mu.Lock()
		if entry := cache.entries[ctr.ID]; entry != nil {
			switch {
			case entry.readAt.IsZero():
				cold = append(cold, ctr.ID)
			case entry.stale(now):
				stale = append(stale, ctr.ID)
			}
		}
		cache.mu.Unlock()
	}

	c.readListeningPorts(cold)
	cache.mu.Lock()
	for id := range cache.entries {
		if _, ok := live[id]; !ok {
			delete(cache.entries, id)
		}
	}
	for i := range containers {
		if entry, ok := cache.entries[containers[i].ID]; ok && entry.usable && entry.ports != nil {
			containers[i].ListeningPorts = slices.Clone(entry.ports)
		}
	}
	refresh := len(stale) > 0 && !cache.refreshing
	if refresh {
		cache.refreshing = true
	}
	cache.mu.Unlock()
	if refresh {
		go func() {
			c.readListeningPorts(stale)
			cache.mu.Lock()
			cache.refreshing = false
			cache.mu.Unlock()
		}()
	}
}

// readListeningPorts reads the namespaces of the given containers with a few workers and stores the results.
func (c *Client) readListeningPorts(ids []string) {
	if len(ids) == 0 {
		return
	}
	cache := &c.listeningPorts
	jobs := make(chan string)
	var wg sync.WaitGroup
	for range min(listeningPortReadWorkers, len(ids)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range jobs {
				cache.mu.Lock()
				entry, ok := cache.entries[id]
				pid := 0
				if ok && entry.usable {
					pid = entry.pid
				}
				cache.mu.Unlock()
				if pid == 0 {
					continue
				}
				ports, err := readListeningTCPPorts(listeningPortProcRoot, pid)
				cache.mu.Lock()
				// The container may have been restarted (new entry) while this read ran.
				if current, ok := cache.entries[id]; ok && current == entry {
					if err == nil {
						entry.ports = ports
					}
					entry.readAt = time.Now()
				}
				cache.mu.Unlock()
			}
		}()
	}
	for _, id := range ids {
		jobs <- id
	}
	close(jobs)
	wg.Wait()
}

// listeningPortTarget resolves the container's init PID and keeps it while
// /proc/<pid>/cgroup still names the container, so a restarted container or a
// reused PID is inspected again instead of reading another process's namespace.
func (c *Client) listeningPortTarget(ctx context.Context, id string) bool {
	cache := &c.listeningPorts
	cache.mu.Lock()
	entry, found := cache.entries[id]
	var pid int
	var usable bool
	var checkedAt time.Time
	if found {
		pid, usable, checkedAt = entry.pid, entry.usable, entry.checkedAt
	}
	cache.mu.Unlock()
	if found && usable && cgroupNamesContainer(listeningPortProcRoot, pid, id) {
		return true
	}
	if found && !usable && time.Since(checkedAt) < listeningPortRecheckAfter {
		return false
	}

	next := &listeningPortTarget{checkedAt: time.Now()}
	inspectCtx, cancel := context.WithTimeout(ctx, listeningPortInspectTimeout)
	result, err := c.cli.ContainerInspect(inspectCtx, id, client.ContainerInspectOptions{})
	cancel()
	if err == nil && result.Container.State != nil && result.Container.State.Running &&
		result.Container.HostConfig != nil && !result.Container.HostConfig.NetworkMode.IsHost() {
		next.pid = result.Container.State.Pid
		next.usable = next.pid > 0 && cgroupNamesContainer(listeningPortProcRoot, next.pid, id)
	}
	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = map[string]*listeningPortTarget{}
	}
	cache.entries[id] = next
	cache.mu.Unlock()
	return next.usable
}

func cgroupNamesContainer(procRoot string, pid int, id string) bool {
	if id == "" {
		return false
	}
	data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cgroup"))
	return err == nil && strings.Contains(string(data), id)
}

// readListeningTCPPorts returns the sorted TCP ports listening on a non-loopback
// address in the network namespace of pid.
func readListeningTCPPorts(procRoot string, pid int) ([]uint16, error) {
	seen := map[uint16]struct{}{}
	var readErr error
	read := 0
	for _, name := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "net", name))
		if err != nil {
			readErr = err
			continue
		}
		read++
		collectListeningTCPPorts(data, seen)
	}
	if read == 0 {
		return nil, readErr
	}
	ports := make([]uint16, 0, len(seen))
	for port := range seen {
		ports = append(ports, port)
	}
	slices.Sort(ports)
	if len(ports) > maxListeningPorts {
		ports = ports[:maxListeningPorts]
	}
	return ports, nil
}

func collectListeningTCPPorts(data []byte, into map[uint16]struct{}) {
	for i, line := range strings.Split(string(data), "\n") {
		if i == 0 {
			continue
		}
		fields := strings.Fields(line)
		// sl local_address rem_address st ...; 0A is TCP_LISTEN.
		if len(fields) < 4 || fields[3] != "0A" {
			continue
		}
		host, portHex, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil || port == 0 {
			continue
		}
		// A loopback listener (including Docker's embedded DNS on 127.0.0.11) is unreachable from a proxy.
		if ip := decodeProcNetIP(host); ip == nil || ip.IsLoopback() {
			continue
		}
		into[uint16(port)] = struct{}{}
	}
}

// decodeProcNetIP decodes an address from /proc/net/tcp{,6}: hex, each 32-bit word in host (little-endian) order.
func decodeProcNetIP(value string) net.IP {
	raw, err := hex.DecodeString(value)
	if err != nil || (len(raw) != net.IPv4len && len(raw) != net.IPv6len) {
		return nil
	}
	ip := make(net.IP, len(raw))
	for word := 0; word < len(raw); word += 4 {
		for b := 0; b < 4; b++ {
			ip[word+b] = raw[word+3-b]
		}
	}
	return ip
}
