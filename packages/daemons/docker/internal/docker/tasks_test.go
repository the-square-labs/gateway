package docker

import (
	"context"
	"testing"
	"time"
)

func TestTaskManagerCancelInterruptsInFlightTask(t *testing.T) {
	manager := NewTaskManager()
	started := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})

	task, err := manager.Submit("container-1", "update", time.Minute, func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		return ctx.Err()
	})
	if err != nil {
		t.Fatalf("submit task: %v", err)
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("task did not start")
	}
	settled := make(chan bool, 1)
	go func() { settled <- manager.CancelAndWait("container-1", time.Second) }()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("task context was not cancelled")
	}
	select {
	case <-settled:
		t.Fatal("cancellation returned before the task stopped")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if !<-settled {
		t.Fatal("expected cancelled task to settle")
	}

	deadline := time.Now().Add(time.Second)
	for {
		got, ok := manager.Get(task.ID)
		if ok && got.Status == TaskFailed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task did not settle as failed: %+v", got)
		}
		time.Sleep(time.Millisecond)
	}
}
