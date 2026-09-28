package logepisode

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func newTracker() (*Tracker, *clock, *slog.Logger, *bytes.Buffer) {
	c := &clock{now: time.Unix(1_800_000_000, 0)}
	var out bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return &Tracker{Now: c.Now}, c, logger, &out
}

func lines(out *bytes.Buffer) []string {
	text := strings.TrimSpace(out.String())
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

var link = Subject{Name: "proxy secure-link connections", IDAttr: "link_id", ID: "link-1"}

// L-1: a route whose target is down for 10 minutes logs its outage in a few lines, not per request.
func TestOutageIsLoggedOncePerStateChangeWithCounts(t *testing.T) {
	tracker, c, logger, out := newTracker()

	for i := 0; i <= 300; i++ { // 10 min at 0.5 req/s
		tracker.Failed(logger, link, "stage", "open", "error", "target endpoint is not registered")
		c.advance(2 * time.Second)
	}
	tracker.Succeeded(logger, link)
	tracker.Succeeded(logger, link)

	got := lines(out)
	if len(got) != 4 {
		t.Fatalf("logged %d lines, want failing + 2 reminders + recovered:\n%s", len(got), out.String())
	}
	for index, want := range []string{
		`level=WARN msg="proxy secure-link connections failing" link_id=link-1 stage=open error="target endpoint is not registered"`,
		`level=WARN msg="proxy secure-link connections still failing" link_id=link-1 failed=150 failing_for=5m0s`,
		`level=WARN msg="proxy secure-link connections still failing" link_id=link-1 failed=150 failing_for=10m0s`,
		`level=INFO msg="proxy secure-link connections recovered" link_id=link-1 failed=301 retried=0 episode=10m2s`,
	} {
		if !strings.Contains(got[index], want) {
			t.Fatalf("line %d = %s\nwant %s", index, got[index], want)
		}
	}
}

func TestHoldEpisodeIsLoggedAtItsStartAndItsEnd(t *testing.T) {
	tracker, c, logger, out := newTracker()

	for i := 0; i < 5; i++ {
		tracker.Retried(logger, link, "stage", "open", "error", "connection refused")
		c.advance(200 * time.Millisecond)
	}
	tracker.Succeeded(logger, link)

	got := lines(out)
	if len(got) != 2 {
		t.Fatalf("logged %d lines:\n%s", len(got), out.String())
	}
	if !strings.Contains(got[0], `level=INFO msg="proxy secure-link connections succeed only after retries" link_id=link-1 stage=open`) {
		t.Fatalf("start = %s", got[0])
	}
	if !strings.Contains(got[1], `msg="proxy secure-link connections recovered" link_id=link-1 failed=0 retried=5 episode=1s`) {
		t.Fatalf("end = %s", got[1])
	}
}

func TestEscalationAndPartialRecoveryAreStateChanges(t *testing.T) {
	tracker, _, logger, out := newTracker()

	tracker.Retried(logger, link)
	tracker.Retried(logger, link)
	tracker.Failed(logger, link, "error", "e1")
	tracker.Failed(logger, link, "error", "e2")
	tracker.Retried(logger, link)
	tracker.Retried(logger, link)
	tracker.Succeeded(logger, link)

	got := lines(out)
	want := []string{
		`msg="proxy secure-link connections succeed only after retries"`,
		`level=WARN msg="proxy secure-link connections failing" link_id=link-1 retried_before=2 error=e1`,
		`msg="proxy secure-link connections succeed again after retries" link_id=link-1 failed=2`,
		`msg="proxy secure-link connections recovered" link_id=link-1 failed=2 retried=4`,
	}
	if len(got) != len(want) {
		t.Fatalf("logged %d lines:\n%s", len(got), out.String())
	}
	for index := range want {
		if !strings.Contains(got[index], want[index]) {
			t.Fatalf("line %d = %s\nwant %s", index, got[index], want[index])
		}
	}
}

func TestSubjectsAreTrackedApartAndHealthySubjectsLogNothing(t *testing.T) {
	tracker, _, logger, out := newTracker()
	other := Subject{Name: link.Name, IDAttr: link.IDAttr, ID: "link-2"}
	registry := Subject{Name: "registry ingress connections", IDAttr: "link_id", ID: "link-1"}

	tracker.Succeeded(logger, link)
	tracker.Failed(logger, link)
	tracker.Failed(logger, other)
	tracker.Failed(logger, registry)
	tracker.Failed(logger, link)

	if got := lines(out); len(got) != 3 {
		t.Fatalf("logged %d lines, want one failing line per subject:\n%s", len(got), out.String())
	}
}

func TestIdleEpisodesExpire(t *testing.T) {
	tracker, c, logger, out := newTracker()
	tracker.Failed(logger, link)
	c.advance(idleExpiry + time.Minute)
	tracker.Failed(logger, Subject{Name: link.Name, IDAttr: link.IDAttr, ID: "link-2"})
	tracker.Failed(logger, link)

	got := lines(out)
	if len(got) != 3 || !strings.Contains(got[2], `msg="proxy secure-link connections failing" link_id=link-1`) {
		t.Fatalf("an episode idle for over an hour starts again:\n%s", out.String())
	}
}

func TestZeroTrackerAndNilLoggerAreSafe(t *testing.T) {
	var tracker Tracker
	tracker.Failed(nil, link)
	tracker.Retried(nil, link)
	tracker.Succeeded(nil, link)
}
