package lifecycle

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var daemonSystemdUnits = map[string]string{
	"nginx":      "nginx-daemon.service",
	"docker":     "docker-daemon.service",
	"monitoring": "monitoring-daemon.service",
	"relay":      "gateway-relay-supervisor.service",
}

func RunUpdateGuardCommand(args []string) (bool, error) {
	if len(args) == 0 {
		return false, errors.New("update guard action is required")
	}
	flags := flag.NewFlagSet("update-guard", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	executable := flags.String("executable", "", "canonical daemon executable path")
	reason := flags.String("reason", "candidate exited", "candidate failure reason")
	if err := flags.Parse(args[1:]); err != nil {
		return false, err
	}
	if !filepath.IsAbs(*executable) {
		return false, errors.New("absolute executable path is required")
	}
	switch args[0] {
	case "start":
		return false, PrepareCandidateStart(*executable)
	case "failure":
		return RecordCandidateFailure(*executable, *reason, time.Now())
	default:
		return false, fmt.Errorf("unsupported update guard action %q", args[0])
	}
}

func EnsureSystemdUpdateGuard(daemonType, executable string) error {
	if runtime.GOOS != "linux" {
		return errors.New("automatic daemon rollback requires Linux systemd")
	}
	unit, ok := daemonSystemdUnits[daemonType]
	if !ok {
		return fmt.Errorf("automatic rollback is not supported for daemon type %q", daemonType)
	}
	cleanExecutable := filepath.Clean(executable)
	if !filepath.IsAbs(cleanExecutable) || strings.ContainsAny(cleanExecutable, "'\n\r") {
		return errors.New("daemon executable path is not safe for a systemd guard")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("automatic daemon rollback requires systemctl")
	}
	dropInDir := filepath.Join("/etc/systemd/system", unit+".d")
	if err := os.MkdirAll(dropInDir, 0755); err != nil {
		return fmt.Errorf("create systemd rollback drop-in directory: %w", err)
	}
	changed, err := writeFileAtomicIfChanged(
		filepath.Join(dropInDir, "20-update-rollback.conf"),
		[]byte(systemdUpdateGuardDropIn(cleanExecutable)),
		0644,
	)
	if err != nil {
		return fmt.Errorf("write systemd rollback drop-in: %w", err)
	}
	if daemonType == "relay" {
		runnerChanged, runnerErr := writeFileAtomicIfChanged(
			"/usr/local/lib/gateway-relay/run-supervisor",
			[]byte("#!/bin/sh\nset -eu\nexec /usr/local/bin/relay-supervisor \"$@\"\n"),
			0755,
		)
		if runnerErr != nil {
			return fmt.Errorf("install relay supervisor rollback runner: %w", runnerErr)
		}
		changed = changed || runnerChanged
	}
	if !changed {
		return nil
	}
	if output, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("reload systemd after rollback guard install: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func EnsureCurrentSystemdUpdateGuard(daemonType string) error {
	executable, err := currentExecutablePath()
	if err != nil {
		return err
	}
	return EnsureSystemdUpdateGuard(daemonType, executable)
}

func systemdUpdateGuardDropIn(executable string) string {
	previous := previousBinaryPath(executable)
	state := pendingUpdatePath(executable)
	return fmt.Sprintf(`[Unit]
StartLimitIntervalSec=120
StartLimitBurst=6

[Service]
ExecStartPre=+/bin/sh -c 'if [ -x "%s" ] && [ -f "%s" ]; then exec "%s" update-guard start --executable "%s"; fi'
ExecStopPost=+/bin/sh -c 'if [ "${SERVICE_RESULT}" != "success" ] && [ -x "%s" ] && [ -f "%s" ]; then exec "%s" update-guard failure --executable "%s" --reason "${SERVICE_RESULT}:${EXIT_CODE}:${EXIT_STATUS}"; fi'
`, previous, state, previous, executable, previous, state, previous, executable)
}

func writeFileAtomicIfChanged(destination string, contents []byte, mode os.FileMode) (bool, error) {
	current, err := os.ReadFile(destination)
	if err == nil && string(current) == string(contents) {
		if chmodErr := os.Chmod(destination, mode); chmodErr != nil {
			return false, chmodErr
		}
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".daemon-update-guard-*")
	if err != nil {
		return false, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if _, err := tmp.Write(contents); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return false, err
	}
	if err := syncDir(filepath.Dir(destination)); err != nil {
		return false, err
	}
	return true, nil
}
