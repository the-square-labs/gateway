package docker

import (
	"context"
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// TaskStatus represents the lifecycle state of an async task.
type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskRunning   TaskStatus = "running"
	TaskSucceeded TaskStatus = "succeeded"
	TaskFailed    TaskStatus = "failed"
)

// Task holds the state of a single async operation (image pull, container update, etc.).
type Task struct {
	ID         string     `json:"id"`
	Status     TaskStatus `json:"status"`
	Container  string     `json:"container"`
	Type       string     `json:"type"`
	Error      string     `json:"error,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// TaskManager queues and tracks async tasks. It enforces at-most-one
// in-flight task per container to prevent concurrent conflicting operations.
type TaskManager struct {
	mu       sync.Mutex
	tasks    map[string]*Task
	inFlight map[string]bool // keyed by container identifier
	cancels  map[string]context.CancelFunc
	done     map[string]chan struct{}
}

// NewTaskManager creates a TaskManager and starts its background cleanup goroutine.
func NewTaskManager() *TaskManager {
	m := &TaskManager{
		tasks:    make(map[string]*Task),
		inFlight: make(map[string]bool),
		cancels:  make(map[string]context.CancelFunc),
		done:     make(map[string]chan struct{}),
	}
	go m.cleanup()
	return m
}

// Submit enqueues a task for the given container/resource. fn receives a context
// that is cancelled when timeout elapses. Returns the newly created Task or an
// error if a task is already running for that container.
func (m *TaskManager) Submit(containerID, taskType string, timeout time.Duration, fn func(ctx context.Context) error) (*Task, error) {
	m.mu.Lock()
	if m.inFlight[containerID] {
		m.mu.Unlock()
		return nil, fmt.Errorf("task already in progress for %q", containerID)
	}
	id := newTaskID()
	t := &Task{
		ID:        id,
		Status:    TaskPending,
		Container: containerID,
		Type:      taskType,
		CreatedAt: time.Now(),
	}
	m.tasks[id] = t
	m.inFlight[containerID] = true
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	done := make(chan struct{})
	m.cancels[containerID] = cancel
	m.done[containerID] = done
	m.mu.Unlock()

	go func() {
		m.mu.Lock()
		now := time.Now()
		t.Status = TaskRunning
		t.StartedAt = &now
		m.mu.Unlock()

		defer cancel()

		err := fn(ctx)

		m.mu.Lock()
		fin := time.Now()
		t.FinishedAt = &fin
		if err != nil {
			t.Status = TaskFailed
			t.Error = err.Error()
		} else {
			t.Status = TaskSucceeded
		}
		delete(m.inFlight, containerID)
		delete(m.cancels, containerID)
		delete(m.done, containerID)
		close(done)
		m.mu.Unlock()
	}()

	return t, nil
}

// CancelAndWait interrupts an in-flight operation and fences on its completion.
// Emergency kill must not send its final SIGKILL until an update/recreate can no
// longer issue a late Docker create/start call.
func (m *TaskManager) CancelAndWait(containerID string, timeout time.Duration) bool {
	m.mu.Lock()
	cancel, ok := m.cancels[containerID]
	done := m.done[containerID]
	m.mu.Unlock()
	if !ok {
		return true
	}
	cancel()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// Get returns a snapshot of the task with the given ID.
func (m *TaskManager) Get(id string) (Task, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return Task{}, false
	}
	return *t, true
}

// List returns snapshots of all tasks.
func (m *TaskManager) List() []Task {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		out = append(out, *t)
	}
	return out
}

// cleanup removes finished tasks older than 1 hour, running every 10 minutes.
func (m *TaskManager) cleanup() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-1 * time.Hour)
		m.mu.Lock()
		for id, t := range m.tasks {
			if t.FinishedAt != nil && t.FinishedAt.Before(cutoff) {
				delete(m.tasks, id)
			}
		}
		m.mu.Unlock()
	}
}

func newTaskID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}
