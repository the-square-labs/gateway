// Package leasefence is the on-disk contract between the docker daemon and
// the independent lease watchdog (A2.2, A12). It is versioned and must stay
// backward compatible: the watchdog is installed and updated independently of
// the daemon, so any daemon version may meet any watchdog version.
//
// Layout under Dir.Root (tmpfs, default /run/gateway-lease-watchdog):
//
//	heartbeat           written by the watchdog every HeartbeatInterval
//	records/<id>.json   one deadline record per lease-mode container,
//	                    written by the daemon
//
// A record names a container, its cgroup and a CLOCK_BOOTTIME deadline in
// nanoseconds. Whenever now >= deadline the watchdog kills every process in
// the container's cgroup without going through dockerd, and keeps doing so
// on every pass, so a start that completes late dies too. A deadline of 0 is
// always stale: a standby that was created but never held cannot run.
package leasefence

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// DefaultRoot is on tmpfs so records vanish on reboot, when lease-mode
	// containers (RestartPolicy no) cannot be running either.
	DefaultRoot = "/run/gateway-lease-watchdog"
	// FormatVersion is the record and heartbeat schema version.
	FormatVersion = 1
	// HeartbeatInterval is how often the watchdog proves its kill loop runs.
	HeartbeatInterval = time.Second
	// HeartbeatMaxAge is how old a heartbeat may be before the daemon treats
	// the watchdog as absent and stops acquiring, starting and renewing.
	HeartbeatMaxAge = 3 * time.Second

	recordsDirName = "records"
	heartbeatName  = "heartbeat"
)

var containerIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidContainerID reports whether id is a full Docker container id.
func ValidContainerID(id string) bool { return containerIDPattern.MatchString(id) }

// Record is one deadline record (A12.1).
type Record struct {
	Version     int    `json:"v"`
	ContainerID string `json:"containerId"`
	// CgroupPath is the container's cgroup directory when known; the watchdog
	// also probes the standard Docker cgroup locations.
	CgroupPath string `json:"cgroupPath,omitempty"`
	PolicyID   string `json:"policyId"`
	Slot       uint32 `json:"slot"`
	// DeadlineNs is a CLOCK_BOOTTIME value; 0 is always stale.
	DeadlineNs int64 `json:"deadlineNs"`
	// WrittenNs is the CLOCK_BOOTTIME time of the write, for diagnostics.
	WrittenNs int64 `json:"writtenNs"`
}

// Deadline returns the record deadline as a clock value.
func (r Record) Deadline() time.Duration { return time.Duration(r.DeadlineNs) }

// Stale reports whether the record's container must be dead at now.
func (r Record) Stale(now time.Duration) bool { return int64(now) >= r.DeadlineNs }

// Heartbeat is the watchdog liveness proof (A12.4).
type Heartbeat struct {
	Version int    `json:"v"`
	NowNs   int64  `json:"nowNs"`
	PID     int    `json:"pid"`
	Build   string `json:"build,omitempty"`
}

// Fresh reports whether the heartbeat was written within HeartbeatMaxAge.
func (h Heartbeat) Fresh(now time.Duration) bool {
	written := time.Duration(h.NowNs)
	return h.NowNs > 0 && now >= written && now-written <= HeartbeatMaxAge
}

// Dir addresses the shared tmpfs directory.
type Dir struct {
	Root string
}

func (d Dir) root() string {
	if d.Root == "" {
		return DefaultRoot
	}
	return d.Root
}

// RecordsDir is where deadline records live.
func (d Dir) RecordsDir() string { return filepath.Join(d.root(), recordsDirName) }

// HeartbeatPath is the watchdog heartbeat file.
func (d Dir) HeartbeatPath() string { return filepath.Join(d.root(), heartbeatName) }

func (d Dir) recordPath(containerID string) string {
	return filepath.Join(d.RecordsDir(), containerID+".json")
}

// WriteRecord atomically replaces the record of r.ContainerID.
func (d Dir) WriteRecord(r Record) error {
	if !ValidContainerID(r.ContainerID) {
		return fmt.Errorf("lease fence record needs a full container id, got %q", r.ContainerID)
	}
	if r.CgroupPath != "" && !filepath.IsAbs(r.CgroupPath) {
		return errors.New("lease fence record cgroup path must be absolute")
	}
	r.Version = FormatVersion
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return writeAtomic(d.RecordsDir(), d.recordPath(r.ContainerID), data, 0o600)
}

// DeleteRecord removes a record; a missing record is not an error.
func (d Dir) DeleteRecord(containerID string) error {
	if !ValidContainerID(containerID) {
		return fmt.Errorf("invalid container id %q", containerID)
	}
	if err := os.Remove(d.recordPath(containerID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ReadRecords returns every well-formed record, sorted by container id, and
// the names of malformed files, which never hide valid records. err is set
// only when the directory itself cannot be read.
func (d Dir) ReadRecords() (records []Record, problems []string, err error) {
	entries, err := os.ReadDir(d.RecordsDir())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		data, readErr := os.ReadFile(filepath.Join(d.RecordsDir(), name))
		if readErr != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", name, readErr))
			continue
		}
		var record Record
		if jsonErr := json.Unmarshal(data, &record); jsonErr != nil || record.ContainerID != id || !ValidContainerID(id) {
			problems = append(problems, fmt.Sprintf("%s: malformed record", name))
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ContainerID < records[j].ContainerID })
	return records, problems, nil
}

// WriteHeartbeat atomically replaces the heartbeat.
func (d Dir) WriteHeartbeat(h Heartbeat) error {
	h.Version = FormatVersion
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	return writeAtomic(d.root(), d.HeartbeatPath(), data, 0o644)
}

// ReadHeartbeat returns the last heartbeat; a missing file is an error.
func (d Dir) ReadHeartbeat() (Heartbeat, error) {
	data, err := os.ReadFile(d.HeartbeatPath())
	if err != nil {
		return Heartbeat{}, err
	}
	var heartbeat Heartbeat
	if err := json.Unmarshal(data, &heartbeat); err != nil {
		return Heartbeat{}, fmt.Errorf("decode lease watchdog heartbeat: %w", err)
	}
	return heartbeat, nil
}

func writeAtomic(dir, path string, data []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
