package nginx

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The nginx master PID is needed on hot paths: every Secure Link connection
// authorizes its peer against it (B-22). Resolving it authoritatively runs
// nginx -T, a full configuration dump; on a one-core ingress under load
// that made every accepted connection wait for a subprocess, the listeners'
// backlogs filled, and they never recovered. CachedPID resolves the pid file
// path at most once per masterPIDPathTTL (or after a reload through this
// manager), re-reads the pid file at most once per masterPIDRecheck, and
// validates a PID only when it changed. Only the path resolution runs a
// subprocess, never more than once per masterPIDPathRetry, and concurrent
// callers wait for a running one instead of starting their own.
const (
	masterPIDRecheck   = time.Second
	masterPIDPathTTL   = 5 * time.Minute
	masterPIDPathRetry = 2 * time.Second
	masterPIDPathWait  = 3 * time.Second
)

type masterPIDCache struct {
	// readMu lets one caller re-read the pid file while the others wait for
	// its result instead of reading it too.
	readMu         sync.Mutex
	mu             sync.Mutex
	pidFile        string
	resolvedAt     time.Time
	pathStale      bool
	resolving      chan struct{}
	lastAttempt    time.Time
	lastErr        error
	pid            int
	checkedAt      time.Time
	expectedBinary string
}

func (c *masterPIDCache) invalidatePath() {
	c.mu.Lock()
	c.pathStale = true
	c.mu.Unlock()
}

// CachedPID returns the nginx master PID like GetPID, without running a
// subprocess on the hot path (see masterPIDCache).
func (m *Manager) CachedPID() (int, error) {
	c := &m.pids
	now := time.Now()
	c.mu.Lock()
	if c.pid > 0 && now.Sub(c.checkedAt) < masterPIDRecheck {
		pid := c.pid
		c.mu.Unlock()
		return pid, nil
	}
	c.mu.Unlock()
	c.readMu.Lock()
	defer c.readMu.Unlock()
	now = time.Now()
	c.mu.Lock()
	if c.pid > 0 && now.Sub(c.checkedAt) < masterPIDRecheck {
		// Another caller re-read it meanwhile.
		pid := c.pid
		c.mu.Unlock()
		return pid, nil
	}
	pidFile, err := m.cachedPIDFileLocked(now)
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	pid, err := m.readPID(pidFile)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.pid, c.lastErr = 0, err
		// The pid file may have moved: resolve the path again (rate-limited).
		c.pathStale = true
		return 0, err
	}
	c.pid, c.checkedAt = pid, now
	return pid, nil
}

// cachedPIDFileLocked returns the pid file path, resolving it when unknown
// or stale. Called with c.mu held; returns with it held.
func (m *Manager) cachedPIDFileLocked(now time.Time) (string, error) {
	c := &m.pids
	for {
		needed := c.pidFile == "" || c.pathStale || now.Sub(c.resolvedAt) > masterPIDPathTTL
		if !needed {
			return c.pidFile, nil
		}
		if waiting := c.resolving; waiting != nil {
			// Another caller runs the resolution: wait for it.
			c.mu.Unlock()
			select {
			case <-waiting:
			case <-time.After(masterPIDPathWait):
			}
			c.mu.Lock()
			if c.resolving == waiting && c.pidFile != "" {
				return c.pidFile, nil
			}
			if c.resolving == waiting {
				return "", errors.New("nginx pid file is still being resolved")
			}
			now = time.Now()
			if c.pidFile != "" && !c.pathStale {
				return c.pidFile, nil
			}
			if c.pidFile == "" && c.lastErr != nil && now.Sub(c.lastAttempt) < masterPIDPathRetry {
				return "", c.lastErr
			}
			continue
		}
		if now.Sub(c.lastAttempt) < masterPIDPathRetry {
			// A resolution ran moments ago: use what it found.
			if c.pidFile != "" {
				return c.pidFile, nil
			}
			if c.lastErr != nil {
				return "", c.lastErr
			}
		}
		done := make(chan struct{})
		c.resolving, c.lastAttempt = done, now
		c.mu.Unlock()
		path, err := m.resolvePIDFile()
		c.mu.Lock()
		c.resolving = nil
		close(done)
		if err != nil {
			c.lastErr = err
			if c.pidFile == "" {
				return "", err
			}
			// Keep serving the last known path.
			return c.pidFile, nil
		}
		c.pidFile, c.resolvedAt, c.pathStale, c.lastErr = path, time.Now(), false, nil
		return path, nil
	}
}

// readMasterPID reads and, when it changed, validates the master PID from the
// pid file. An unreadable file first gets the OpenRC directory repair.
func (m *Manager) readMasterPID(pidFile string) (int, error) {
	data, err := readTrustedPIDFile(pidFile)
	if err != nil {
		if prepareErr := prepareOpenRCPIDDirectory(pidFile); prepareErr == nil {
			data, err = readTrustedPIDFile(pidFile)
		}
		if err != nil {
			return 0, err
		}
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("parse pid file %s", pidFile)
	}
	c := &m.pids
	c.mu.Lock()
	known, expected := c.pid, c.expectedBinary
	c.mu.Unlock()
	if pid == known {
		return pid, nil
	}
	if expected == "" {
		if expected, err = canonicalBinaryPath(m.binary); err != nil {
			return 0, err
		}
		c.mu.Lock()
		c.expectedBinary = expected
		c.mu.Unlock()
	}
	if err := validateNginxMasterPID(pid, expected); err != nil {
		return 0, err
	}
	return pid, nil
}
