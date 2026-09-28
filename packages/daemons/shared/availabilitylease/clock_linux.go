//go:build linux

package availabilitylease

import (
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func (systemClock) Now() time.Duration {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts); err != nil {
		return time.Since(processStart)
	}
	return time.Duration(ts.Nano())
}

var processStart = time.Now()

func readBootID() string {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return string(data)
}

// SuspendGap returns CLOCK_BOOTTIME minus CLOCK_MONOTONIC: the time this host
// spent in a real suspend (S3, s2idle, hibernation) since boot. Both clocks
// are slewed alike by NTP and neither is stepped, so the gap only grows when
// the kernel suspends. A hypervisor pause is not a suspend: both stand still
// and the gap stays; peer time detects that (freeze.go). ok is false where
// the clocks cannot be read.
func SuspendGap() (gap time.Duration, ok bool) {
	var boot, mono unix.Timespec
	if unix.ClockGettime(unix.CLOCK_MONOTONIC, &mono) != nil || unix.ClockGettime(unix.CLOCK_BOOTTIME, &boot) != nil {
		return 0, false
	}
	return time.Duration(boot.Nano() - mono.Nano()), true
}
