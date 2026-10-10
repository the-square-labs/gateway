package logepisode

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestNotedLogsInfoOnceAndSummarises(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug}))
	now := time.Unix(1_800_000_000, 0)
	tracker := &Tracker{Now: func() time.Time { return now }}
	subject := Subject{Name: "proxy secure-link streams", IDAttr: "link_id", ID: "l1"}

	for range 40 {
		tracker.Noted(logger, subject, "cut by their target", "reason", "restart")
	}
	if lines := strings.Count(out.String(), "\n"); lines != 1 {
		t.Fatalf("40 noted outcomes logged %d lines, want 1:\n%s", lines, out.String())
	}
	if !strings.Contains(out.String(), "level=INFO") || !strings.Contains(out.String(), `msg="proxy secure-link streams cut by their target"`) {
		t.Fatalf("unexpected line: %s", out.String())
	}

	now = now.Add(DefaultReminder)
	tracker.Noted(logger, subject, "cut by their target")
	if !strings.Contains(out.String(), "count=40") || strings.Contains(out.String(), "level=WARN") {
		t.Fatalf("summary missing or not info:\n%s", out.String())
	}
}
