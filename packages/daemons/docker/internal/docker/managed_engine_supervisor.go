package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	mobyclient "github.com/moby/moby/client"
)

// Managed database and storage engines keep their data on a loop-mounted
// image. Docker must never start one on its own: at boot it would do so before
// this daemon mounted the image, and the engine would initialise an empty data
// directory on the root filesystem. Their restart policy is therefore "no",
// and this daemon is the only one that starts them, always after mounting the
// image: at its own start, when an engine stops while it should run (a crash,
// an OOM kill) and after a Docker restart.
var engineRestartPolicy = container.RestartPolicy{Name: container.RestartPolicyDisabled}

const (
	engineRestartFirstDelay  = time.Second
	engineRestartMaxDelay    = time.Minute
	engineRestartStableAfter = time.Minute
	engineRestartTimeout     = 2 * time.Minute
	engineEventsRetryDelay   = 5 * time.Second
)

// ensureEngineRestartPolicy turns Docker's own restart off for an engine
// container created by an older daemon ("unless-stopped"), live and without
// recreating it.
func ensureEngineRestartPolicy(ctx context.Context, client *Client, containerID string) error {
	inspect, err := client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return nil
		}
		return err
	}
	if hostConfig := inspect.Container.HostConfig; hostConfig == nil ||
		hostConfig.RestartPolicy.Name == "" || hostConfig.RestartPolicy.Name == container.RestartPolicyDisabled {
		return nil
	}
	policy := engineRestartPolicy
	if _, err := client.cli.ContainerUpdate(ctx, containerID, mobyclient.ContainerUpdateOptions{RestartPolicy: &policy}); err != nil {
		return fmt.Errorf("turn off Docker restart of engine container: %w", err)
	}
	return nil
}

// engineStopped reports whether an engine container exists and is not running;
// a missing container is left to the Gateway's repair.
func engineStopped(ctx context.Context, client *Client, containerID string) (bool, error) {
	inspect, err := client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, err
	}
	return inspect.Container.State == nil || !inspect.Container.State.Running, nil
}

// startStoppedEngine starts the database's engine if it should run and is not
// running, after mounting its image; it never starts it without the image.
// containerID, when set, is the container whose stop triggered this: a stop of
// a container since replaced or removed is ignored.
func (m *managedDatabaseManager) startStoppedEngine(ctx context.Context, id, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !record.DesiredRunning || record.Deleting || record.ContainerID == "" || (containerID != "" && containerID != record.ContainerID) {
		return nil
	}
	if stopped, err := engineStopped(ctx, m.client, record.ContainerID); err != nil || !stopped {
		return err
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
		if err := m.saveRecord(record); err != nil {
			return err
		}
		return runtimeFilesMissingError("managed database", missing)
	}
	if _, err := m.client.cli.ContainerStart(ctx, record.ContainerID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed database container: %w", err)
	}
	m.logger.Info("started managed database engine after mounting its storage", "id", id)
	return m.saveRecord(record)
}

// startStoppedEngine is the managed storage variant; a removed member is never
// started.
func (m *managedStorageManager) startStoppedEngine(ctx context.Context, id, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !record.DesiredRunning || record.Removed || record.ContainerID == "" || (containerID != "" && containerID != record.ContainerID) {
		return nil
	}
	if stopped, err := engineStopped(ctx, m.client, record.ContainerID); err != nil || !stopped {
		return err
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
		if err := m.saveRecord(record); err != nil {
			return err
		}
		return runtimeFilesMissingError("managed storage", missing)
	}
	if _, err := m.client.cli.ContainerStart(ctx, record.ContainerID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed storage container: %w", err)
	}
	m.logger.Info("started managed storage engine after mounting its storage", "id", id)
	return m.saveRecord(record)
}

// engineRestarts spaces the restarts of an engine that keeps stopping, like
// Docker's own backoff: the delay doubles up to a minute and starts over once
// an engine ran for a minute.
type engineRestarts struct {
	mu      sync.Mutex
	delay   map[string]time.Duration
	last    map[string]time.Time
	pending map[string]bool
	after   func(time.Duration, func())
	now     func() time.Time
}

func newEngineRestarts() *engineRestarts {
	return &engineRestarts{
		delay:   map[string]time.Duration{},
		last:    map[string]time.Time{},
		pending: map[string]bool{},
		after:   func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		now:     time.Now,
	}
}

func (r *engineRestarts) schedule(key string, run func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending[key] {
		return
	}
	delay := r.delay[key]
	if delay == 0 || r.now().Sub(r.last[key]) > engineRestartStableAfter {
		delay = engineRestartFirstDelay
	}
	r.delay[key] = min(2*delay, engineRestartMaxDelay)
	r.pending[key] = true
	r.after(delay, func() {
		r.mu.Lock()
		r.pending[key] = false
		r.last[key] = r.now()
		r.mu.Unlock()
		run()
	})
}

// runManagedEngineSupervisor follows Docker's container events for the life
// of the process and starts engines that stopped while they should run.
func (p *DockerPlugin) runManagedEngineSupervisor(ctx context.Context) {
	restarts := newEngineRestarts()
	for {
		p.watchEngineEvents(ctx, restarts)
		select {
		case <-ctx.Done():
			return
		case <-time.After(engineEventsRetryDelay):
		}
	}
}

func (p *DockerPlugin) watchEngineEvents(ctx context.Context, restarts *engineRestarts) {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream := p.client.cli.Events(streamCtx, mobyclient.EventsListOptions{
		Filters: mobyclient.Filters{}.Add("type", string(events.ContainerEventType)).Add("event", string(events.ActionDie)),
	})
	select {
	case err := <-stream.Err:
		// Docker is not answering (it is restarting); retried shortly.
		p.logger.Debug("managed engine supervision could not open the Docker event stream", "error", err)
		return
	default:
	}
	// Engines that stopped while no stream was open (a Docker restart, which
	// stops them without restarting them) start now.
	p.startStoppedEngines(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-stream.Err:
			if err != nil && ctx.Err() == nil {
				p.logger.Warn("managed engine supervision lost the Docker event stream", "error", err)
			}
			return
		case message := <-stream.Messages:
			p.handleEngineStop(ctx, restarts, message)
		}
	}
}

func (p *DockerPlugin) handleEngineStop(ctx context.Context, restarts *engineRestarts, message events.Message) {
	containerID := message.Actor.ID
	if id := message.Actor.Attributes[managedDatabaseLabel]; id != "" && p.databaseManager != nil {
		restarts.schedule("database/"+id, func() {
			restartCtx, cancel := context.WithTimeout(ctx, engineRestartTimeout)
			defer cancel()
			if err := p.databaseManager.startStoppedEngine(restartCtx, id, containerID); err != nil {
				p.logger.Warn("stopped managed database engine was not started", "id", id, "error", err)
			}
		})
	}
	if id := message.Actor.Attributes[managedStorageLabel]; id != "" && p.storageManager != nil {
		restarts.schedule("storage/"+id, func() {
			restartCtx, cancel := context.WithTimeout(ctx, engineRestartTimeout)
			defer cancel()
			if err := p.storageManager.startStoppedEngine(restartCtx, id, containerID); err != nil {
				p.logger.Warn("stopped managed storage engine was not started", "id", id, "error", err)
			}
		})
	}
}

// startStoppedEngines starts every engine that should run and does not.
func (p *DockerPlugin) startStoppedEngines(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, loopImageRepairTimeout)
	defer cancel()
	if p.databaseManager != nil {
		for _, id := range engineRecordIDs(filepath.Join(p.databaseManager.root, "records")) {
			if err := p.databaseManager.startStoppedEngine(ctx, id, ""); err != nil {
				p.logger.Warn("stopped managed database engine was not started", "id", id, "error", err)
			}
		}
	}
	if p.storageManager != nil {
		for _, id := range engineRecordIDs(filepath.Join(p.storageManager.root, "storage", "records")) {
			if err := p.storageManager.startStoppedEngine(ctx, id, ""); err != nil {
				p.logger.Warn("stopped managed storage engine was not started", "id", id, "error", err)
			}
		}
	}
}

func engineRecordIDs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var ids []string
	for _, entry := range entries {
		if id, ok := strings.CutSuffix(entry.Name(), ".json"); ok && !entry.IsDir() {
			ids = append(ids, id)
		}
	}
	return ids
}
