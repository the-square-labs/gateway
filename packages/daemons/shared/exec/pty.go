package exec

import (
	"bufio"
	"context"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

// CreatePTYSession creates or reuses a PTY-backed shell session on the host OS.
// key is a lookup key for session reuse (e.g., "node-console").
// shell can be "auto" to auto-detect, or a specific path like "/bin/bash".
// runAsUser is an optional OS username; empty means run as daemon's user.
func (m *Manager) CreatePTYSession(ctx context.Context, key, shell string, rows, cols int, runAsUser string) (execID string, isNew bool, err error) {
	m.mu.Lock()
	existing, ok := m.sessions[key]
	m.mu.Unlock()

	// Reuse existing session if still alive
	if ok {
		existing.touch()
		m.logger.Info("reusing PTY session", "exec_id", existing.ID, "key", key)
		return existing.ID, false, nil
	}

	// Resolve shell
	if shell == "" || shell == "auto" {
		shell = DetectShell()
	}

	// Build command
	cmd := osexec.CommandContext(ctx, shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	if err := applyRunAsUser(cmd, runAsUser); err != nil {
		return "", false, err
	}

	// Start with PTY
	winSize := &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	ptmx, startErr := pty.StartWithSize(cmd, winSize)
	if startErr != nil {
		return "", false, fmt.Errorf("failed to start PTY: %w", startErr)
	}

	sessionCtx, sessionCancel := context.WithCancel(ctx)
	execID = uuid.New().String()

	session := &Session{
		ID:         execID,
		Key:        key,
		stdin:      ptmx, // PTY master is read+write
		cancel:     sessionCancel,
		lastActive: time.Now(),
		onExit: func() int32 {
			if cmd.ProcessState != nil {
				return int32(cmd.ProcessState.ExitCode())
			}
			return -1
		},
		resizeFn: func(r, c int) error {
			return pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(r), Cols: uint16(c)})
		},
	}

	m.mu.Lock()
	m.sessions[key] = session
	m.mu.Unlock()

	// Wait for process exit in background to populate ProcessState
	go func() {
		cmd.Wait()
		ptmx.Close()
	}()

	go m.readOutput(sessionCtx, session, ptmx)

	m.logger.Info("PTY session created", "exec_id", execID, "key", key, "shell", shell)
	return execID, true, nil
}

// DetectShell reads /etc/shells and returns the best available shell.
func DetectShell() string {
	preferred := []string{"/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/ash", "/bin/sh"}

	available := make(map[string]bool)
	f, err := os.Open("/etc/shells")
	if err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line != "" && !strings.HasPrefix(line, "#") {
				available[line] = true
			}
		}
	}

	// If we parsed /etc/shells, prefer from that list
	if len(available) > 0 {
		for _, sh := range preferred {
			if available[sh] {
				return sh
			}
		}
	}

	// Fallback: check if preferred shells exist on disk
	for _, sh := range preferred {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}

	return "/bin/sh"
}
