package lifecycle

import (
	"testing"
	"time"
)

// Control sessions that keep failing back off to at most 15 s (10 s jittered by up to half), and an accepted session
// reconnects after about a second; every delay is jittered so the nodes of one Gateway do not reconnect in step.
func TestControlSessionBackoffCapsWithJitter(t *testing.T) {
	draw := 0.999999
	backoff := controlSessionBackoff{random: func() float64 { return draw }}
	var delay time.Duration
	for range 12 {
		delay = backoff.next(false, time.Second)
	}
	if delay > 15*time.Second || delay < 14*time.Second {
		t.Fatalf("failing sessions back off %v, want just under 15s", delay)
	}
	draw = 0
	if delay = backoff.next(false, time.Second); delay != 5*time.Second {
		t.Fatalf("lowest jitter at the cap %v, want 5s", delay)
	}
	if delay = backoff.next(true, time.Second); delay != 500*time.Millisecond {
		t.Fatalf("accepted session reconnects after %v, want 0.5s with the lowest jitter", delay)
	}
	draw = 0.5
	if delay = backoff.next(false, time.Second); delay != time.Second {
		t.Fatalf("first failure after an accepted session waits %v, want 1s", delay)
	}
}
