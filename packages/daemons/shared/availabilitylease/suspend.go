package availabilitylease

import (
	"sync"
	"time"
)

// suspendReportThreshold is the smallest real suspend SuspendWatch reports.
const suspendReportThreshold = time.Second

// SuspendWatch reports real host suspends (S3, s2idle, hibernation): the
// growth of CLOCK_BOOTTIME over CLOCK_MONOTONIC between two checks. The lease
// clock is BOOTTIME, so lease timers already count such a suspend: a holder
// whose budget ran out while suspended fences on its timer at the next tick.
// The watch is for logs and reports only. The wall clock plays no part: a
// wall-clock step (NTP, any direction, any size) is never evidence of a
// suspend or a freeze (D4).
type SuspendWatch struct {
	mu   sync.Mutex
	read func() (time.Duration, bool)
	last time.Duration
	ok   bool
}

// NewSuspendWatch starts a watch on the host clocks.
func NewSuspendWatch() *SuspendWatch { return NewSuspendWatchFrom(SuspendGap) }

// NewSuspendWatchFrom starts a watch on another source of the BOOTTIME minus
// MONOTONIC gap (tests).
func NewSuspendWatchFrom(read func() (time.Duration, bool)) *SuspendWatch {
	w := &SuspendWatch{read: read}
	w.last, w.ok = read()
	return w
}

// Check returns how long the host was suspended since the previous check, or
// zero when it was not (or the clocks cannot be read).
func (w *SuspendWatch) Check() time.Duration {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	gap, ok := w.read()
	if !ok {
		return 0
	}
	previous, known := w.last, w.ok
	w.last, w.ok = gap, true
	if !known {
		return 0
	}
	if grown := gap - previous; grown >= suspendReportThreshold {
		return grown
	}
	return 0
}
