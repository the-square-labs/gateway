package availabilitylease

import "time"

// Clock is a monotonic clock that keeps counting while the host is suspended
// (CLOCK_BOOTTIME on Linux). Values are durations since an arbitrary origin and
// are never compared across processes or restored from disk (A3).
type Clock interface {
	Now() time.Duration
}

// SystemClock returns the host BOOTTIME clock where available and the Go
// monotonic clock elsewhere.
func SystemClock() Clock { return systemClock{} }

type systemClock struct{}
