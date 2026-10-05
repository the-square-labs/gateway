package relayresume

import "sync/atomic"

// WindowBudget bounds the window growth (bytes above MinWindow) of every
// session of a process.
type WindowBudget struct {
	limit int64
	used  atomic.Int64
}

// NewWindowBudget allows limit bytes of window growth; 0: DefaultProcessBudget.
func NewWindowBudget(limit int64) *WindowBudget {
	if limit <= 0 {
		limit = DefaultProcessBudget
	}
	return &WindowBudget{limit: limit}
}

func (b *WindowBudget) reserve(n uint64) bool {
	for {
		used := b.used.Load()
		if used+int64(n) > b.limit {
			return false
		}
		if b.used.CompareAndSwap(used, used+int64(n)) {
			return true
		}
	}
}

func (b *WindowBudget) release(n uint64) {
	b.used.Add(-int64(n))
}

// Used is the window growth reserved now.
func (b *WindowBudget) Used() int64 { return b.used.Load() }

// Limit is the budget.
func (b *WindowBudget) Limit() int64 { return b.limit }
