//go:build linux

package leasefence

import (
	"time"

	"golang.org/x/sys/unix"
)

// Now returns CLOCK_BOOTTIME: it is system-wide, keeps counting across host
// suspend, and is the clock the lease protocol anchors deadlines on (A1).
func Now() time.Duration {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts); err != nil {
		return 0
	}
	return time.Duration(ts.Nano())
}
