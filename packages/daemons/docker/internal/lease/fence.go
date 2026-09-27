package lease

import (
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
)

// DirFence is the production Fence: the watchdog's tmpfs directory.
type DirFence struct {
	Dir leasefence.Dir
}

var _ Fence = DirFence{}

func (f DirFence) HeartbeatFresh(now time.Duration) bool {
	heartbeat, err := f.Dir.ReadHeartbeat()
	return err == nil && heartbeat.Fresh(now)
}

func (f DirFence) Records() (map[string]leasefence.Record, error) {
	records, _, err := f.Dir.ReadRecords()
	if err != nil {
		return nil, err
	}
	out := make(map[string]leasefence.Record, len(records))
	for _, record := range records {
		out[record.ContainerID] = record
	}
	return out, nil
}

func (f DirFence) WriteRecord(record leasefence.Record) error { return f.Dir.WriteRecord(record) }

func (f DirFence) DeleteRecord(containerID string) error { return f.Dir.DeleteRecord(containerID) }
