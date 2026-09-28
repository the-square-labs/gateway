//go:build !linux

package availabilitylease

import "time"

var processStart = time.Now()

func (systemClock) Now() time.Duration { return time.Since(processStart) }

func readBootID() string { return "" }

// SuspendGap is unavailable off Linux.
func SuspendGap() (time.Duration, bool) { return 0, false }
