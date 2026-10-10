package relayresume

import "sync"

// Signal wakes every waiter at once: Wait returns a channel that closes at the
// next Fire (SourceConfig.Wake). The zero value is ready to use.
type Signal struct {
	mu sync.Mutex
	ch chan struct{}
}

// Wait returns the channel the next Fire closes.
func (w *Signal) Wait() <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ch == nil {
		w.ch = make(chan struct{})
	}
	return w.ch
}

// Fire wakes the current waiters.
func (w *Signal) Fire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ch != nil {
		close(w.ch)
		w.ch = nil
	}
}
