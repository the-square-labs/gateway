package lifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const (
	launcherStateSchemaVersion = 1
	launcherFailureThreshold   = 3
	launcherFailureWindow      = 90 * time.Second
)

type launcherUpdateFailure struct {
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
}

type launcherUpdateState struct {
	SchemaVersion int                     `json:"schemaVersion"`
	DaemonType    string                  `json:"daemonType"`
	FromVersion   string                  `json:"fromVersion"`
	TargetVersion string                  `json:"targetVersion"`
	BinaryPath    string                  `json:"binaryPath"`
	PreviousPath  string                  `json:"previousPath"`
	Phase         string                  `json:"phase"`
	StagedAt      time.Time               `json:"stagedAt"`
	CandidateAt   *time.Time              `json:"candidateStartedAt,omitempty"`
	LocalReadyAt  *time.Time              `json:"localReadyAt,omitempty"`
	Failures      []launcherUpdateFailure `json:"failures,omitempty"`
}

type launcherUpdateOutcome struct {
	SchemaVersion   int       `json:"schemaVersion"`
	Status          string    `json:"status"`
	DaemonType      string    `json:"daemonType"`
	FromVersion     string    `json:"fromVersion"`
	TargetVersion   string    `json:"targetVersion"`
	RestoredVersion string    `json:"restoredVersion"`
	Reason          string    `json:"reason"`
	OccurredAt      time.Time `json:"occurredAt"`
}

func launcherStatePath(stateDir string) string {
	return filepath.Join(stateDir, "launcher", "update-state.json")
}

func launcherOutcomePath(stateDir string) string {
	return filepath.Join(stateDir, "launcher", "update-outcome.json")
}

func readLauncherUpdateState(stateDir string) (*launcherUpdateState, error) {
	contents, err := os.ReadFile(launcherStatePath(stateDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var state launcherUpdateState
	if err := json.Unmarshal(contents, &state); err != nil {
		return nil, fmt.Errorf("decode launcher update state: %w", err)
	}
	validPhase := state.Phase == "staged" || state.Phase == "candidate" || state.Phase == "ready_stabilizing"
	if state.SchemaVersion != launcherStateSchemaVersion || state.DaemonType == "" || state.FromVersion == "" || state.TargetVersion == "" || !validPhase || !filepath.IsAbs(state.BinaryPath) || filepath.Clean(state.PreviousPath) != filepath.Clean(state.BinaryPath)+".previous" {
		return nil, errors.New("launcher update state is invalid")
	}
	return &state, nil
}

func writeLauncherUpdateState(stateDir string, state *launcherUpdateState) error {
	if state == nil {
		return errors.New("launcher update state is required")
	}
	state.SchemaVersion = launcherStateSchemaVersion
	return writeJSONFileAtomic(launcherStatePath(stateDir), state, 0600)
}

func removeLauncherUpdateState(stateDir string) error {
	path := launcherStatePath(stateDir)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func stageLauncherUpdate(stateDir, daemonType, binaryPath, fromVersion, targetVersion string, stagedAt time.Time) (*launcherUpdateState, error) {
	if current, err := readLauncherUpdateState(stateDir); err != nil {
		return nil, err
	} else if current != nil {
		return nil, fmt.Errorf("daemon update to %s is already pending", current.TargetVersion)
	}
	previousPath := binaryPath + ".previous"
	if err := copyExecutableAtomic(binaryPath, previousPath); err != nil {
		return nil, fmt.Errorf("preserve previous daemon binary: %w", err)
	}
	state := &launcherUpdateState{
		SchemaVersion: launcherStateSchemaVersion,
		DaemonType:    daemonType,
		FromVersion:   fromVersion,
		TargetVersion: targetVersion,
		BinaryPath:    binaryPath,
		PreviousPath:  previousPath,
		Phase:         "staged",
		StagedAt:      stagedAt.UTC(),
	}
	if err := writeLauncherUpdateState(stateDir, state); err != nil {
		_ = os.Remove(previousPath)
		return nil, fmt.Errorf("persist launcher update state: %w", err)
	}
	return state, nil
}

func markLauncherCandidateStarted(stateDir string, state *launcherUpdateState, now time.Time) error {
	startedAt := now.UTC()
	state.Phase = "candidate"
	state.CandidateAt = &startedAt
	state.LocalReadyAt = nil
	return writeLauncherUpdateState(stateDir, state)
}

func markLauncherLocalReady(stateDir string, state *launcherUpdateState, now time.Time) error {
	readyAt := now.UTC()
	state.Phase = "ready_stabilizing"
	state.LocalReadyAt = &readyAt
	return writeLauncherUpdateState(stateDir, state)
}

func recordLauncherCandidateFailure(stateDir string, state *launcherUpdateState, reason string, now time.Time) (bool, error) {
	cutoff := now.Add(-launcherFailureWindow)
	failures := make([]launcherUpdateFailure, 0, len(state.Failures)+1)
	for _, failure := range state.Failures {
		if !failure.At.Before(cutoff) {
			failures = append(failures, failure)
		}
	}
	failures = append(failures, launcherUpdateFailure{At: now.UTC(), Reason: reason})
	state.Failures = failures
	state.LocalReadyAt = nil
	if len(failures) < launcherFailureThreshold {
		state.Phase = "candidate"
		return false, writeLauncherUpdateState(stateDir, state)
	}
	if err := rollbackLauncherUpdate(stateDir, state, reason); err != nil {
		return false, err
	}
	return true, nil
}

func rollbackLauncherUpdate(stateDir string, state *launcherUpdateState, reason string) error {
	if filepath.Clean(state.BinaryPath) == filepath.Clean(state.PreviousPath) {
		return errors.New("launcher rollback paths must differ")
	}
	// Keep the known-good backup in place until a later successful update
	// replaces it. Copying makes rollback idempotent if power is lost after the
	// executable is restored but before the journal is removed.
	if err := copyExecutableAtomic(state.PreviousPath, state.BinaryPath); err != nil {
		return fmt.Errorf("restore previous daemon binary: %w", err)
	}
	outcomeErr := writeJSONFileAtomic(launcherOutcomePath(stateDir), &launcherUpdateOutcome{
		SchemaVersion:   launcherStateSchemaVersion,
		Status:          "rolled_back",
		DaemonType:      state.DaemonType,
		FromVersion:     state.FromVersion,
		TargetVersion:   state.TargetVersion,
		RestoredVersion: state.FromVersion,
		Reason:          reason,
		OccurredAt:      time.Now().UTC(),
	}, 0600)
	stateErr := removeLauncherUpdateState(stateDir)
	return errors.Join(outcomeErr, stateErr)
}

func copyExecutableAtomic(source, destination string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("source executable is not a regular file")
	}
	if err := ensureExecutableDestinationDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".launcher-copy-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), src); err != nil {
		_ = tmp.Close()
		return err
	}
	mode := info.Mode().Perm()
	if mode&0111 == 0 {
		mode = 0755
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	writtenChecksum, err := executableChecksum(tmpPath)
	if err != nil {
		return err
	}
	if writtenChecksum != hex.EncodeToString(hasher.Sum(nil)) {
		return errors.New("copied executable checksum mismatch")
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(destination))
}

func ensureExecutableDestinationDirectory(path string) error {
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("executable destination parent is not a directory")
	}
	return nil
}

func executableChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func writeJSONFileAtomic(destination string, value any, mode os.FileMode) error {
	contents, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := ensurePrivateLauncherDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".launcher-state-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(contents); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(destination))
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func ensurePrivateLauncherDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("launcher state path is not a private directory")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return errors.New("launcher state directory is owned by another user")
	}
	return os.Chmod(path, 0700)
}
