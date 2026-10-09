package docker

import (
	"time"

	"github.com/moby/moby/api/types/container"
)

// engineRun is what the daemon saw of a managed storage engine container; a
// start on purpose (create, update, start, restart) begins it anew.
type engineRun struct {
	// served: it passed its readiness check since it last started.
	served bool
	// exited: it keeps stopping on its own (it crashed or was OOM-killed and
	// has not served since); reported stopped until it serves.
	exited bool
	// stopRequested: its last stop was asked for through Docker's API (an
	// operator's docker stop), not a crash; the supervisor brings it back.
	stopRequested bool
	// restartedAt: when the supervisor last started it after it stopped.
	restartedAt time.Time
	// oomKilled: its last stop was the kernel's out-of-memory kill.
	oomKilled bool
}

func (m *managedStorageManager) engineRun(containerID string) engineRun {
	m.engineRunsMu.Lock()
	defer m.engineRunsMu.Unlock()
	return m.engineRuns[containerID]
}

func (m *managedStorageManager) setEngineRun(containerID string, run engineRun) {
	m.updateEngineRun(containerID, func(engineRun) engineRun { return run })
}

func (m *managedStorageManager) updateEngineRun(containerID string, change func(engineRun) engineRun) {
	m.engineRunsMu.Lock()
	defer m.engineRunsMu.Unlock()
	if m.engineRuns == nil {
		m.engineRuns = map[string]engineRun{}
	}
	m.engineRuns[containerID] = change(m.engineRuns[containerID])
}

func (m *managedStorageManager) forgetEngineRun(containerID string) {
	m.engineRunsMu.Lock()
	defer m.engineRunsMu.Unlock()
	delete(m.engineRuns, containerID)
}

// recordEngineStop records why an engine container died, as the supervisor's
// event stream tells it, before the supervisor starts it again.
func (m *managedStorageManager) recordEngineStop(containerID string, requested, oom bool) {
	m.updateEngineRun(containerID, func(run engineRun) engineRun {
		run.stopRequested = requested
		run.oomKilled = oom && !requested
		return run
	})
}

// engineServed records an engine that passed its readiness check.
func (m *managedStorageManager) engineServed(containerID string) {
	m.updateEngineRun(containerID, func(run engineRun) engineRun {
		return engineRun{served: true, restartedAt: run.restartedAt}
	})
}

// engineKeepsExiting reports an engine that stopped on its own and has not
// served since the supervisor started it again.
func (m *managedStorageManager) engineKeepsExiting(record managedStorageRecord) bool {
	return m.engineRun(record.ContainerID).exited
}

// engineDidNotComeBack reports an engine the supervisor started again after a
// stop that has not served within its readiness timeout although it runs.
func (m *managedStorageManager) engineDidNotComeBack(record managedStorageRecord) bool {
	run := m.engineRun(record.ContainerID)
	return !run.served && !run.restartedAt.IsZero() && time.Since(run.restartedAt) > managedStorageReadyTimeout(record)
}

// engineRestarting reports an engine stopped through Docker's API (an
// operator's docker stop) while it should run: the supervisor starts it again
// within seconds, so it is starting, not stopped. An engine that keeps
// crashing stays stopped.
func (m *managedStorageManager) engineRestarting(record managedStorageRecord, state *container.State) bool {
	run := m.engineRun(record.ContainerID)
	if !record.DesiredRunning || !run.stopRequested || run.exited {
		return false
	}
	finished, err := time.Parse(time.RFC3339Nano, state.FinishedAt)
	return err == nil && time.Since(finished) < engineRestartTimeout
}

// restartedEngineRun is the run of an engine the supervisor started again;
// afterStop is false for a start no stop event asked for (daemon start, Docker
// restart). After a stop asked for through Docker's API the engine is only
// starting and keeps what it did before; after a crash or an OOM kill it keeps
// stopping, and is reported stopped until it serves.
func restartedEngineRun(run engineRun, afterStop bool, now time.Time) engineRun {
	switch {
	case !afterStop:
		return engineRun{exited: run.exited}
	case run.stopRequested:
		return engineRun{exited: run.exited, restartedAt: now}
	default:
		return engineRun{exited: true, restartedAt: now}
	}
}
