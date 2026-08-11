package nginx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestTailFileFollowsAppendedLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "proxy-host.access.log")
	if err := os.WriteFile(logPath, []byte("existing\n"), 0o600); err != nil {
		t.Fatalf("write log file: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lines := make(chan string, 4)
	errs := make(chan error, 1)
	go func() {
		errs <- TailFile(ctx, logPath, lines)
	}()

	time.Sleep(50 * time.Millisecond)
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open log file: %v", err)
	}
	if _, err := f.WriteString("appended\n"); err != nil {
		t.Fatalf("append log line: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close log file: %v", err)
	}

	select {
	case line := <-lines:
		if line != "appended" {
			t.Fatalf("unexpected line: %q", line)
		}
	case err := <-errs:
		t.Fatalf("tail exited early: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for appended log line")
	}
}

func TestTailLastNReadsOnlyRequestedSuffix(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "proxy-host.access.log")
	if err := os.WriteFile(logPath, []byte("one\ntwo\nthree\nfour\n"), 0o600); err != nil {
		t.Fatalf("write log file: %v", err)
	}

	lines, err := TailLastN(logPath, 2)
	if err != nil {
		t.Fatalf("tail last lines: %v", err)
	}

	expected := []string{"three", "four"}
	if !reflect.DeepEqual(lines, expected) {
		t.Fatalf("unexpected lines: got %#v want %#v", lines, expected)
	}
}

func TestTailLastNReadsLargeFileFromEnd(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "proxy-host.access.log")
	f, err := os.Create(logPath)
	if err != nil {
		t.Fatalf("create log file: %v", err)
	}
	for i := 0; i < 9000; i++ {
		if _, err := f.WriteString("padding-line-with-enough-bytes-to-cross-the-default-tail-chunk\n"); err != nil {
			t.Fatalf("write padding line: %v", err)
		}
	}
	for _, line := range []string{"keep-1", "keep-2", "keep-3"} {
		if _, err := f.WriteString(line + "\n"); err != nil {
			t.Fatalf("write tail line: %v", err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close log file: %v", err)
	}

	lines, err := TailLastN(logPath, 3)
	if err != nil {
		t.Fatalf("tail last lines: %v", err)
	}

	expected := []string{"keep-1", "keep-2", "keep-3"}
	if !reflect.DeepEqual(lines, expected) {
		t.Fatalf("unexpected lines: got %#v want %#v", lines, expected)
	}
}

func TestParseLogLineReadsGatewayTimingFields(t *testing.T) {
	line := `192.0.2.10 - - [11/Aug/2026:12:34:56 +0000] "GET /api HTTP/1.1" 200 1234 "-" "agent" 0.042 0.050`
	entry := ParseLogLine("host-1", line)
	if entry.Status != 200 || entry.BodyBytesSent != 1234 {
		t.Fatalf("unexpected parsed response: %#v", entry)
	}
	if entry.UpstreamResponseTime != "0.042" || entry.RequestTime != "0.050" {
		t.Fatalf("timing fields were not parsed: %#v", entry)
	}
}
