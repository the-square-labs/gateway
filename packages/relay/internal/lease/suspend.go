package lease

import (
	"sync"
	"time"
)

// suspendThreshold is how far CLOCK_REALTIME may run ahead of the lease clock
// between two checks before the relay treats the gap as a suspend. NTP slews
// stay far below it; a step of this size closes gates once, which is safe.
const suspendThreshold = 2 * time.Second

// suspendDetector compares the wall clock jump with the lease clock jump
// (A17). Under a VM freeze or RAM snapshot the lease clock (BOOTTIME under
// kvmclock) stands still while the wall clock is corrected on resume, so the
// difference is the time the relay missed.
type suspendDetector struct {
	mu       sync.Mutex
	wall     func() time.Time
	mono     func() time.Duration
	lastWall int64
	lastMono time.Duration
}

func newSuspendDetector(wall func() time.Time, mono func() time.Duration) *suspendDetector {
	return &suspendDetector{wall: wall, mono: mono, lastWall: wall().UnixNano(), lastMono: mono()}
}

// check returns the detected suspend length, or zero. It reads the wall clock
// without its monotonic reading, which would hide the jump.
func (d *suspendDetector) check() time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	wall, mono := d.wall().UnixNano(), d.mono()
	wallJump := time.Duration(wall - d.lastWall)
	monoJump := mono - d.lastMono
	d.lastWall, d.lastMono = wall, mono
	if missed := wallJump - monoJump; missed > suspendThreshold {
		return missed
	}
	return 0
}
