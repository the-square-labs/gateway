package nginx

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func cachedPIDManager(resolve func() (string, error), read func(string) (int, error)) *Manager {
	m := NewManager("nginx", "", "", "")
	m.resolvePIDFile, m.readPID = resolve, read
	return m
}

// B-22: every Secure Link connection needs the master PID. Only the pid file path resolution runs a subprocess
// (nginx -T), and it runs once, not per call, however many callers ask at once.
func TestCachedPIDResolvesThePathOnceForConcurrentCallers(t *testing.T) {
	var resolves, reads atomic.Int32
	m := cachedPIDManager(func() (string, error) {
		resolves.Add(1)
		time.Sleep(50 * time.Millisecond) // nginx -T
		return "/run/nginx.pid", nil
	}, func(path string) (int, error) {
		reads.Add(1)
		return 4242, nil
	})
	var wg sync.WaitGroup
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				if pid, err := m.CachedPID(); err != nil || pid != 4242 {
					t.Errorf("pid = %d, %v", pid, err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if got := resolves.Load(); got != 1 {
		t.Fatalf("path resolved %d times for 10000 calls", got)
	}
	if got := reads.Load(); got > 5 {
		t.Fatalf("pid file read %d times within a second", got)
	}
}

func TestCachedPIDReResolvesAfterAReloadAndRateLimitsFailures(t *testing.T) {
	var resolves atomic.Int32
	failing := true
	m := cachedPIDManager(func() (string, error) {
		resolves.Add(1)
		if failing {
			return "", errors.New("nginx -T failed")
		}
		return "/run/nginx.pid", nil
	}, func(string) (int, error) { return 7, nil })
	for range 100 {
		if _, err := m.CachedPID(); err == nil {
			t.Fatal("a failed resolution returned a pid")
		}
	}
	if got := resolves.Load(); got != 1 {
		t.Fatalf("a failing resolution ran %d times in a burst", got)
	}
	failing = false
	m.pids.mu.Lock()
	m.pids.lastAttempt = time.Now().Add(-masterPIDPathRetry)
	m.pids.mu.Unlock()
	if pid, err := m.CachedPID(); err != nil || pid != 7 {
		t.Fatalf("after the retry spacing: %d, %v", pid, err)
	}
	m.pids.invalidatePath()
	m.pids.mu.Lock()
	m.pids.checkedAt = time.Time{}
	m.pids.lastAttempt = time.Time{}
	m.pids.mu.Unlock()
	if _, err := m.CachedPID(); err != nil {
		t.Fatal(err)
	}
	if got := resolves.Load(); got != 3 {
		t.Fatalf("resolutions = %d, want one more after the reload", got)
	}
}

// A pid file that cannot be read (nginx restarting) is re-read on the next call and schedules a new path
// resolution, rate-limited.
func TestCachedPIDFollowsANewMaster(t *testing.T) {
	pid := 100
	m := cachedPIDManager(func() (string, error) { return "/run/nginx.pid", nil }, func(string) (int, error) { return pid, nil })
	if got, _ := m.CachedPID(); got != 100 {
		t.Fatalf("pid = %d", got)
	}
	pid = 200
	m.pids.mu.Lock()
	m.pids.checkedAt = time.Now().Add(-masterPIDRecheck)
	m.pids.mu.Unlock()
	if got, _ := m.CachedPID(); got != 200 {
		t.Fatalf("pid after the master changed = %d", got)
	}
}
