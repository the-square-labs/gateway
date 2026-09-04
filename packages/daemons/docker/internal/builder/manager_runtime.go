package builder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func (m *Manager) scan(ctx context.Context, command *pb.DockerBuildCommand, jobDir, imageRef, imageDigest string) (string, error) {
	tagSeparator := strings.LastIndex(imageRef, ":")
	if tagSeparator < 0 {
		return "", errors.New("built image reference has no tag")
	}
	subject := imageRef[:tagSeparator] + "@" + imageDigest
	sbomPath := filepath.Join(jobDir, "sbom.cdx.json")
	scanEnv := registryScanEnvironment(os.Environ(), m.config.RegistryCAPath)
	if err := m.runCommand(ctx, command.GetBuildId(), jobDir, scanEnv, "syft", "registry:"+subject, "-o", "cyclonedx-json="+sbomPath); err != nil {
		return "", err
	}
	scanPath := filepath.Join(jobDir, "scan.json")
	if err := m.runCommand(ctx, command.GetBuildId(), jobDir, scanEnv, "grype", "sbom:"+sbomPath, "-o", "json", "--file", scanPath); err != nil {
		return "", err
	}
	summary, err := summarizeGrype(scanPath)
	return summary, err
}

func registryScanEnvironment(base []string, caPath string) []string {
	const syftCA = "SYFT_REGISTRY_CA_CERT="
	const grypeCA = "GRYPE_REGISTRY_CA_CERT="
	environment := make([]string, 0, len(base)+2)
	for _, entry := range base {
		if strings.HasPrefix(entry, syftCA) || strings.HasPrefix(entry, grypeCA) {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment, syftCA+caPath, grypeCA+caPath)
}

func (m *Manager) runCommand(ctx context.Context, buildID, dir string, env []string, name string, args ...string) error {
	executable, err := m.executable(name)
	if err != nil {
		return fmt.Errorf("resolve builder executable %s: %w", name, err)
	}
	command := exec.CommandContext(ctx, executable, args...)
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		return command.Process.Signal(os.Interrupt)
	}
	command.WaitDelay = commandCancellationGrace
	command.Dir = dir
	command.Env = env
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	copyLogs := func(reader io.Reader) {
		defer wg.Done()
		redactor := newStreamRedactor(m.secretValues(buildID), func(chunk []byte) {
			m.emitLog(buildID, chunk)
		})
		buffer := make([]byte, maxBuildLogChunk)
		_, _ = io.CopyBuffer(redactor, reader, buffer)
		redactor.Flush()
	}
	wg.Add(2)
	go copyLogs(stdout)
	go copyLogs(stderr)
	err = command.Wait()
	wg.Wait()
	return err
}

func (m *Manager) prune(ctx context.Context, buildID string) error {
	return m.runCommand(
		ctx,
		buildID,
		"",
		os.Environ(),
		"buildctl",
		"--addr",
		"unix://"+m.config.BuildkitSocket,
		"prune",
		"--all",
	)
}

func (m *Manager) pruneAfterJob(buildID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := m.prune(ctx, buildID); err != nil {
		m.log(buildID, []byte("builder cache cleanup failed: "+err.Error()))
	}
}

func (m *Manager) monitorStorage(ctx context.Context, limit int64, paths ...string) error {
	check := func() error {
		usage, err := directoryUsage(paths...)
		if err != nil {
			return fmt.Errorf("measure isolated builder storage: %w", err)
		}
		if usage > limit {
			return fmt.Errorf("%w: used %d bytes, limit %d bytes", errDiskLimit, usage, limit)
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := check(); err != nil {
				return err
			}
		}
	}
}

func directoryUsage(paths ...string) (int64, error) {
	var total int64
	for _, root := range paths {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				if storageEntryDisappeared(root, path, walkErr) {
					return nil
				}
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				if storageEntryDisappeared(root, path, err) {
					return nil
				}
				return err
			}
			total += info.Size()
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return 0, err
		}
	}
	return total, nil
}

// BuildKit can remove or replace a child directory between WalkDir's stat and
// open. Resample on the next tick; never hide root configuration or I/O errors.
func storageEntryDisappeared(root, path string, err error) bool {
	return os.IsNotExist(err) || (path != root && errors.Is(err, syscall.ENOTDIR))
}

func (m *Manager) failForContext(command *pb.DockerBuildCommand, ctx context.Context, fallbackCode string, err error) {
	cause := context.Cause(ctx)
	switch {
	case errors.Is(cause, errDiskLimit):
		m.fail(command, "BUILD_RESOURCE_LIMIT_EXCEEDED", cause)
	case cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded):
		m.fail(command, "BUILD_RESOURCE_ACCOUNTING_FAILED", cause)
	case errors.Is(cause, context.DeadlineExceeded):
		m.fail(command, "BUILD_TIMEOUT", cause)
	case errors.Is(cause, context.Canceled):
		m.fail(command, "BUILD_CANCELLED", cause)
	default:
		m.fail(command, fallbackCode, err)
	}
}

func (m *Manager) status(command *pb.DockerBuildCommand, status string) {
	_ = m.emitEvent(&pb.DockerBuildEvent{BuildId: command.GetBuildId(), Status: status, Attempt: command.GetAttempt(), OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) fail(command *pb.DockerBuildCommand, code string, err error) {
	m.emitTerminal(&pb.DockerBuildEvent{BuildId: command.GetBuildId(), Status: "failed", ErrorCode: code, ErrorMessage: err.Error(), Attempt: command.GetAttempt(), OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) log(buildID string, chunk []byte) {
	redactor := newStreamRedactor(m.secretValues(buildID), func(redacted []byte) {
		m.emitLog(buildID, redacted)
	})
	_, _ = redactor.Write(chunk)
	redactor.Flush()
}

func (m *Manager) secretValues(buildID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.secrets[buildID]...)
}

func (m *Manager) emitLog(buildID string, chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	_ = m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: "log", Sequence: m.sequence.Add(1), LogChunk: append([]byte(nil), chunk...), Attempt: m.attemptFor(buildID), OccurredAtUnixMs: time.Now().UnixMilli()})
}
func (m *Manager) attemptFor(buildID string) uint32 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.attempts[buildID]
}

func (m *Manager) emitEvent(event *pb.DockerBuildEvent) error {
	if m.emit != nil {
		return m.emit(event)
	}
	return errors.New("build event sink is unavailable")
}

func (m *Manager) emitTerminal(event *pb.DockerBuildEvent) {
	if event == nil {
		return
	}
	m.mu.Lock()
	m.terminalEvents[event.GetBuildId()] = event
	m.mu.Unlock()
}

func (m *Manager) takeTerminal(buildID string) *pb.DockerBuildEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	event := m.terminalEvents[buildID]
	delete(m.terminalEvents, buildID)
	return event
}

func (m *Manager) deliverTerminal(event *pb.DockerBuildEvent) {
	if event.GetAttempt() == 0 {
		_ = m.emitEvent(event)
		return
	}
	key := terminalAckKey(event.GetBuildId(), event.GetAttempt())
	ack := make(chan string, 1)
	m.mu.Lock()
	m.terminalAcks[key] = ack
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.terminalAcks[key] == ack {
			delete(m.terminalAcks, key)
		}
		m.mu.Unlock()
	}()

	retry := time.NewTicker(m.terminalRetryInterval)
	timeout := time.NewTimer(m.terminalAckTimeout)
	defer retry.Stop()
	defer timeout.Stop()
	for {
		_ = m.emitEvent(event)
		select {
		case <-ack:
			return
		case <-retry.C:
		case <-timeout.C:
			return
		}
	}
}
