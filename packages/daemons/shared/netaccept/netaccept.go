// Package netaccept keeps accept loops alive through transient errors.
//
// A listener's Accept fails transiently when the process runs out of file
// descriptors under load (EMFILE, ENFILE) or the kernel is short of buffers.
// An accept loop that returns on the first error leaves its listener open but
// never accepting again: connections pile up in its backlog for the rest of
// the process's life (B-22). Only closing the listener ends these loops.
package netaccept

import (
	"errors"
	"net"
	"time"
)

const (
	initialBackoff = 5 * time.Millisecond
	maxBackoff     = time.Second
)

// Backoff decides what an accept loop does after an Accept error: false when
// the listener was closed or stop closed (the loop ends), true after waiting
// out a growing pause for a transient error. Reset it after a successful
// Accept.
type Backoff struct {
	next time.Duration
}

func (b *Backoff) Retry(err error, stop <-chan struct{}) bool {
	if errors.Is(err, net.ErrClosed) {
		return false
	}
	if b.next == 0 {
		b.next = initialBackoff
	}
	timer := time.NewTimer(b.next)
	defer timer.Stop()
	select {
	case <-stop:
		return false
	case <-timer.C:
	}
	b.next = min(b.next*2, maxBackoff)
	return true
}

func (b *Backoff) Reset() { b.next = 0 }

// Serve accepts connections until the listener is closed or stop closes and
// hands each to handle in its own goroutine.
func Serve(listener net.Listener, stop <-chan struct{}, handle func(net.Conn)) {
	var backoff Backoff
	for {
		connection, err := listener.Accept()
		if err != nil {
			if !backoff.Retry(err, stop) {
				return
			}
			continue
		}
		backoff.Reset()
		go handle(connection)
	}
}
