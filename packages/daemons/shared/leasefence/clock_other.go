//go:build !linux

package leasefence

import "time"

var processStart = time.Now()

// Now is a process-local monotonic clock off Linux, for development only:
// the watchdog and the lease protocol run on Linux, where Now is BOOTTIME.
func Now() time.Duration { return time.Since(processStart) }
