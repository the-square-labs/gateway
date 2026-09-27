//go:build linux

package availabilitylease

import (
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
