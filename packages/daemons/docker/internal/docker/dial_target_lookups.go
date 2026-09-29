package docker

import (
	"context"
	"errors"
	"sync"
	"time"
)

const (
	// dialTargetAnswerWait is how long a relayed connection waits for dockerd
	// to name its target before it uses the last address dockerd named (B-26).
	dialTargetAnswerWait = 300 * time.Millisecond
	// dialTargetLookupLimit bounds one lookup, which runs on after the
	// connections that wait for it gave up, so its answer refreshes the last
	// known address.
	dialTargetLookupLimit = 10 * time.Second
)

// dockerUnansweredError is a target lookup dockerd did not answer (frozen,
// restarting, overloaded): no evidence that the target changed. Its text is
// the caller's usual one.
type dockerUnansweredError struct {
	message string
	cause   error
}

func (e dockerUnansweredError) Error() string { return e.message }
func (e dockerUnansweredError) Unwrap() error { return e.cause }

func dockerUnanswered(err error) bool {
	var unanswered dockerUnansweredError
	return errors.As(err, &unanswered)
}

// dialTargetLookups asks dockerd for the address of a relayed connection's
// target, one lookup per target at a time, and answers from the last address
// dockerd named for it when dockerd does not answer within
// dialTargetAnswerWait (B-26). A frozen dockerd then holds no connection, and
// only dockerd can hand that address to another container. A definitive
// answer (gone, stopped, another identity) is used at once and forgets the
// address. Without a known address a connection waits for the answer.
type dialTargetLookups struct {
	mu       sync.Mutex
	known    map[string]string
	inflight map[string]*dialTargetLookup
}

type dialTargetLookup struct {
	done  chan struct{}
	value string
	err   error
}

func (l *dialTargetLookups) get(ctx context.Context, key string, lookup func(context.Context) (string, error)) (string, error) {
	l.mu.Lock()
	if l.known == nil {
		l.known = map[string]string{}
		l.inflight = map[string]*dialTargetLookup{}
	}
	call := l.inflight[key]
	if call == nil {
		call = &dialTargetLookup{done: make(chan struct{})}
		l.inflight[key] = call
		go l.run(key, call, lookup)
	}
	known, haveKnown := l.known[key]
	l.mu.Unlock()

	var answerWait <-chan time.Time
	if haveKnown {
		timer := time.NewTimer(dialTargetAnswerWait)
		defer timer.Stop()
		answerWait = timer.C
	}
	select {
	case <-call.done:
		if call.err != nil && haveKnown && dockerUnanswered(call.err) {
			return known, nil
		}
		return call.value, call.err
	case <-answerWait:
		return known, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (l *dialTargetLookups) run(key string, call *dialTargetLookup, lookup func(context.Context) (string, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), dialTargetLookupLimit)
	value, err := lookup(ctx)
	cancel()
	if err != nil && ctx.Err() != nil && !dockerUnanswered(err) {
		err = dockerUnansweredError{message: err.Error(), cause: err}
	}
	l.mu.Lock()
	call.value, call.err = value, err
	switch {
	case err == nil:
		l.known[key] = value
	case !dockerUnanswered(err):
		delete(l.known, key)
	}
	delete(l.inflight, key)
	l.mu.Unlock()
	close(call.done)
}
