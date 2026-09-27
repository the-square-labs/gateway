//go:build !linux

package availabilitylease

import "time"

var processStart = time.Now()

func (systemClock) Now() time.Duration { return time.Since(processStart) }
