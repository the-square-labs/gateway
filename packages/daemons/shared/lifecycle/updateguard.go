package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	updateStateSchemaVersion = 1
	updateFailureThreshold   = 3
	updateFailureWindow      = 90 * time.Second
)

type UpdateFailure struct {
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
}

type PendingUpdate struct {
	SchemaVersion    int             `json:"schemaVersion"`
	FromVersion      string          `json:"fromVersion"`
	TargetVersion    string          `json:"targetVersion"`
	StagedAt         time.Time       `json:"stagedAt"`
	CandidateStarted bool            `json:"candidateStarted,omitempty"`
	Failures         []UpdateFailure `json:"failures,omitempty"`
}

func PrepareCandidateStart(executable string) error {
	state, err := ReadPendingUpdate(executable)
	if err != nil || state == nil {
		return err
	}
	if state.SchemaVersion != updateStateSchemaVersion || state.FromVersion == "" {
		return errors.New("pending update marker does not support automatic rollback")
	}
	state.CandidateStarted = true
	return writeJSONAtomic(pendingUpdatePath(executable), state, 0600)
}

type UpdateOutcome struct {
	SchemaVersion   int       `json:"schemaVersion"`
	Status          string    `json:"status"`
	FromVersion     string    `json:"fromVersion"`
	TargetVersion   string    `json:"targetVersion"`
	RestoredVersion string    `json:"restoredVersion"`
	Reason          string    `json:"reason"`
	OccurredAt      time.Time `json:"occurredAt"`
}

func pendingUpdatePath(executable string) string       { return executable + ".update-state.json" }
func legacyPendingUpdatePath(executable string) string { return executable + ".update-pending" }
func previousBinaryPath(executable string) string      { return executable + ".previous" }
func updateOutcomePath(executable string) string       { return executable + ".update-outcome.json" }

func StagePendingUpdate(executable, fromVersion, targetVersion string, now time.Time) error {
	if strings.TrimSpace(targetVersion) == "" {
		return errors.New("target version is required")
	}
	if _, err := os.Stat(pendingUpdatePath(executable)); err == nil {
		return errors.New("another daemon update is already pending")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := os.Stat(legacyPendingUpdatePath(executable)); err == nil {
		return errors.New("a legacy daemon update is already pending")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	state := PendingUpdate{
		SchemaVersion: updateStateSchemaVersion,
		FromVersion:   strings.TrimSpace(fromVersion),
		TargetVersion: strings.TrimSpace(targetVersion),
		StagedAt:      now.UTC(),
	}
	return writeJSONAtomic(pendingUpdatePath(executable), state, 0600)
}

func ReadPendingUpdate(executable string) (*PendingUpdate, error) {
	contents, err := os.ReadFile(pendingUpdatePath(executable))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		contents, err = os.ReadFile(legacyPendingUpdatePath(executable))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, nil
			}
			return nil, err
		}
	}
	var state PendingUpdate
	if err := json.Unmarshal(contents, &state); err == nil && state.TargetVersion != "" {
		return &state, nil
	}
	// Relay supervisor releases before the shared guard stored only the target
	// version in this marker. Read that form so the bootstrap release can still
	// commit an already-staged update, but never invent rollback metadata.
	legacyTarget := strings.TrimSpace(string(contents))
	if legacyTarget == "" {
		return nil, errors.New("pending update marker is empty")
	}
	return &PendingUpdate{TargetVersion: legacyTarget}, nil
}

func CommitPendingUpdate(executable, targetVersion string) error {
	state, err := ReadPendingUpdate(executable)
	if err != nil {
		return err
	}
	if state == nil {
		return nil
	}
	if state.TargetVersion != strings.TrimSpace(targetVersion) {
		return fmt.Errorf("pending update target %s does not match commit target %s", state.TargetVersion, targetVersion)
	}
	if err := os.Remove(pendingUpdatePath(executable)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(legacyPendingUpdatePath(executable)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Keep .previous until the next successfully staged update. It is tiny and
	// remains the last known-good recovery point for post-commit diagnosis.
	return syncDir(filepath.Dir(executable))
}

// RecordCandidateFailure records one locally classified candidate failure.
// It returns true only when the previous binary was restored.
func RecordCandidateFailure(executable, reason string, now time.Time) (bool, error) {
	state, err := ReadPendingUpdate(executable)
	if err != nil || state == nil {
		return false, err
	}
	if state.SchemaVersion != updateStateSchemaVersion || state.FromVersion == "" {
		return false, errors.New("pending update marker does not support automatic rollback")
	}
	// The old daemon stages the marker before it exits. Its own ExecStopPost
	// must not be counted as a failed candidate start; ExecStartPre marks the
	// first actual candidate attempt immediately before systemd launches it.
	if !state.CandidateStarted {
		return false, nil
	}
	state.CandidateStarted = false
	cutoff := now.Add(-updateFailureWindow)
	failures := make([]UpdateFailure, 0, len(state.Failures)+1)
	for _, failure := range state.Failures {
		if !failure.At.Before(cutoff) {
			failures = append(failures, failure)
		}
	}
	failures = append(failures, UpdateFailure{At: now.UTC(), Reason: strings.TrimSpace(reason)})
	state.Failures = failures
	if len(failures) < updateFailureThreshold {
		return false, writeJSONAtomic(pendingUpdatePath(executable), state, 0600)
	}
	if err := rollbackPendingUpdate(executable, state, reason, now); err != nil {
		return false, err
	}
	return true, nil
}

func rollbackPendingUpdate(executable string, state *PendingUpdate, reason string, now time.Time) error {
	backup := previousBinaryPath(executable)
	if _, err := os.Stat(backup); err != nil {
		return fmt.Errorf("stat previous daemon binary: %w", err)
	}
	if err := os.Rename(backup, executable); err != nil {
		return fmt.Errorf("restore previous daemon binary: %w", err)
	}
	if err := syncDir(filepath.Dir(executable)); err != nil {
		return fmt.Errorf("sync restored daemon binary: %w", err)
	}
	outcome := UpdateOutcome{
		SchemaVersion:   updateStateSchemaVersion,
		Status:          "rolled_back",
		FromVersion:     state.FromVersion,
		TargetVersion:   state.TargetVersion,
		RestoredVersion: state.FromVersion,
		Reason:          strings.TrimSpace(reason),
		OccurredAt:      now.UTC(),
	}
	if err := writeJSONAtomic(updateOutcomePath(executable), outcome, 0600); err != nil {
		return fmt.Errorf("write rollback outcome: %w", err)
	}
	if err := os.Remove(pendingUpdatePath(executable)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove pending update marker: %w", err)
	}
	if err := os.Remove(legacyPendingUpdatePath(executable)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove legacy pending update marker: %w", err)
	}
	return syncDir(filepath.Dir(executable))
}

func ReadUpdateOutcome(executable string) (*UpdateOutcome, error) {
	contents, err := os.ReadFile(updateOutcomePath(executable))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var outcome UpdateOutcome
	if err := json.Unmarshal(contents, &outcome); err != nil {
		return nil, err
	}
	if outcome.SchemaVersion != updateStateSchemaVersion || outcome.Status != "rolled_back" {
		return nil, errors.New("unsupported daemon update outcome")
	}
	return &outcome, nil
}

func ReadCurrentUpdateOutcome() (*UpdateOutcome, error) {
	executable, err := currentExecutablePath()
	if err != nil {
		return nil, err
	}
	return ReadUpdateOutcome(executable)
}

// PendingUpdateSupportsRollback reports whether the currently running
// candidate was actually started by the shared systemd guard and has a usable
// N-1 binary. Merely running code that understands rollback is not enough: the
// first upgrade from a legacy daemon has no shared state and must reconcile as
// a legacy update.
func PendingUpdateSupportsRollback(executable, currentVersion string) (bool, error) {
	state, err := ReadPendingUpdate(executable)
	if err != nil || state == nil {
		return false, err
	}
	if state.SchemaVersion != updateStateSchemaVersion || state.FromVersion == "" || !state.CandidateStarted {
		return false, nil
	}
	if state.TargetVersion != strings.TrimSpace(currentVersion) {
		return false, nil
	}
	backup, err := os.Stat(previousBinaryPath(executable))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return backup.Mode().IsRegular() && backup.Mode().Perm()&0111 != 0, nil
}

func CurrentUpdateSupportsRollback() (bool, error) {
	executable, err := currentExecutablePath()
	if err != nil {
		return false, err
	}
	return PendingUpdateSupportsRollback(executable, Version)
}

func FinalizeCurrentUpdate(targetVersion string, acknowledgeRollback bool) error {
	executable, err := currentExecutablePath()
	if err != nil {
		return err
	}
	return finalizeUpdate(executable, Version, targetVersion, acknowledgeRollback)
}

func finalizeUpdate(executable, currentVersion, targetVersion string, acknowledgeRollback bool) error {
	if !acknowledgeRollback {
		if currentVersion != targetVersion {
			return fmt.Errorf("daemon version %s does not match commit target %s", currentVersion, targetVersion)
		}
		state, err := ReadPendingUpdate(executable)
		if err != nil {
			return err
		}
		if state == nil {
			return errors.New("no pending daemon update to commit")
		}
		return CommitPendingUpdate(executable, targetVersion)
	}
	outcome, err := ReadUpdateOutcome(executable)
	if err != nil {
		return err
	}
	if outcome == nil {
		return nil
	}
	if outcome.TargetVersion != targetVersion {
		return fmt.Errorf("rollback outcome target %s does not match acknowledgement target %s", outcome.TargetVersion, targetVersion)
	}
	return ClearUpdateOutcome(executable)
}

func ClearUpdateOutcome(executable string) error {
	if err := os.Remove(updateOutcomePath(executable)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Dir(executable))
}

func writeJSONAtomic(destination string, value any, mode os.FileMode) error {
	contents, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".daemon-update-state-*")
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
	return syncDir(filepath.Dir(destination))
}

func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}

func currentExecutablePath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve daemon executable: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve daemon executable symlink: %w", err)
	}
	return executable, nil
}
