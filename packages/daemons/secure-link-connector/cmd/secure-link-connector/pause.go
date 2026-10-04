package main

import (
	"context"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// pauseCommand runs the image as the connector's anchor: a container that only holds the network namespace (the
// management and link network endpoints, their addresses and aliases) the connector containers join. It sleeps and
// reaps, so it never needs replacing when the connector image changes.
const pauseCommand = "pause"

func runPause(ctx context.Context) {
	children := make(chan os.Signal, 1)
	signal.Notify(children, syscall.SIGCHLD)
	for {
		select {
		case <-ctx.Done():
			return
		case <-children:
			for {
				var status syscall.WaitStatus
				if pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil); pid <= 0 || err != nil {
					break
				}
			}
		}
	}
}

const (
	cgroupMemoryPollInterval = time.Minute
	// cgroupMemoryUnlimited: a cgroup v1 limit at or above this is "no limit".
	cgroupMemoryUnlimited = int64(1) << 60
)

// followCgroupMemoryLimit keeps the Go memory limit at 90% of the container's memory limit, so the runtime collects
// before the kernel kills. A GOMEMLIMIT in the environment wins.
func followCgroupMemoryLimit(ctx context.Context) {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	applied := int64(0)
	ticker := time.NewTicker(cgroupMemoryPollInterval)
	defer ticker.Stop()
	for {
		if limit := cgroupMemoryLimit(); limit > 0 && limit != applied {
			debug.SetMemoryLimit(limit / 10 * 9)
			applied = limit
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// cgroupMemoryLimit reads the memory limit of the container's cgroup (v2, else v1); 0 when there is none.
func cgroupMemoryLimit() int64 {
	for _, path := range []string{"/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"} {
		if limit, ok := parseCgroupMemoryLimit(path); ok {
			return limit
		}
	}
	return 0
}

func parseCgroupMemoryLimit(path string) (int64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	value := strings.TrimSpace(string(data))
	if value == "max" {
		return 0, true
	}
	limit, err := strconv.ParseInt(value, 10, 64)
	if err != nil || limit <= 0 || limit >= cgroupMemoryUnlimited {
		return 0, true
	}
	return limit, true
}
