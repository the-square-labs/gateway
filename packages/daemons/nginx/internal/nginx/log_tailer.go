package nginx

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type LogEntryParsed struct {
	HostID               string
	Timestamp            string
	RemoteAddr           string
	Method               string
	Path                 string
	Status               int
	BodyBytesSent        int64
	Referer              string
	UserAgent            string
	UpstreamResponseTime string
	RequestTime          string
	Raw                  string
}

// combined log format regex
var logLineRegex = regexp.MustCompile(
	`^(\S+) - \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d+) (\d+) "([^"]*)" "([^"]*)"(?:\s+(\S+)\s+(\S+))?`,
)

// ParseLogLine parses a single nginx combined-format log line.
func ParseLogLine(hostID, line string) *LogEntryParsed {
	entry := &LogEntryParsed{
		HostID: hostID,
		Raw:    line,
	}

	matches := logLineRegex.FindStringSubmatch(line)
	if matches == nil {
		return entry
	}

	entry.RemoteAddr = matches[1]
	entry.Timestamp = matches[2]
	entry.Method = matches[3]
	entry.Path = matches[4]
	entry.Status, _ = strconv.Atoi(matches[5])
	entry.BodyBytesSent, _ = strconv.ParseInt(matches[6], 10, 64)
	entry.Referer = matches[7]
	entry.UserAgent = matches[8]
	if len(matches) > 9 {
		entry.UpstreamResponseTime = matches[9]
	}
	if len(matches) > 10 {
		entry.RequestTime = matches[10]
	}

	// Compatibility with older custom log formats that used a named suffix.
	if entry.UpstreamResponseTime == "" {
		if idx := strings.Index(line, "upstream_response_time="); idx >= 0 {
			rest := line[idx+len("upstream_response_time="):]
			if spIdx := strings.IndexAny(rest, " \t\n"); spIdx >= 0 {
				entry.UpstreamResponseTime = rest[:spIdx]
			} else {
				entry.UpstreamResponseTime = rest
			}
		}
	}

	return entry
}

// TailFile tails a file and sends lines to the channel. Blocks until ctx is cancelled.
func TailFile(ctx context.Context, path string, lines chan<- string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	defer f.Close()

	// Seek to end
	if _, err := f.Seek(0, 2); err != nil {
		return fmt.Errorf("seek to end: %w", err)
	}

	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\r\n")
			select {
			case <-ctx.Done():
				return nil
			case lines <- line:
			}
		}
		if err == nil {
			continue
		}
		if !errors.Is(err, io.EOF) {
			return fmt.Errorf("read log file: %w", err)
		}
		if len(line) == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
}

// TailLastN reads the last N lines of a file.
func TailLastN(path string, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if stat.Size() == 0 {
		return nil, nil
	}

	const chunkSize int64 = 64 * 1024
	pos := stat.Size()
	newlineCount := 0
	tail := make([]byte, 0, minInt64(stat.Size(), chunkSize))

	for pos > 0 && newlineCount <= n {
		readSize := minInt64(pos, chunkSize)
		pos -= readSize

		chunk := make([]byte, readSize)
		read, err := f.ReadAt(chunk, pos)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		chunk = chunk[:read]
		newlineCount += bytes.Count(chunk, []byte{'\n'})

		next := make([]byte, 0, len(chunk)+len(tail))
		next = append(next, chunk...)
		next = append(next, tail...)
		tail = next
	}

	trimmed := strings.TrimRight(string(tail), "\r\n")
	if trimmed == "" {
		return nil, nil
	}
	allLines := strings.Split(trimmed, "\n")
	if len(allLines) <= n {
		return allLines, nil
	}
	return allLines[len(allLines)-n:], nil
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// ParseErrorLevel extracts the severity level from an nginx error log line.
// Format: "2024/01/15 10:30:45 [error] 1234#0: ..."
var errorLevelRe = regexp.MustCompile(`\[(emerg|alert|crit|error|warn|notice|info|debug)\]`)

func ParseErrorLevel(line string) string {
	m := errorLevelRe.FindStringSubmatch(line)
	if len(m) >= 2 {
		return m[1]
	}
	return "error"
}
