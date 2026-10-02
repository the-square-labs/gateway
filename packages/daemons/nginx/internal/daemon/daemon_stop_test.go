package daemon

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A stop hands the sockets over and then must not wait for a control session
// that closes slowly: the next process starts only once this one exited.
func TestRunStopsWaitingForASlowSessionCloseAfterTheHandover(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	handedOver := make(chan struct{})
	run := func(ctx context.Context) error {
		<-ctx.Done()
		time.Sleep(2 * time.Second)
		return nil
	}
	done := make(chan bool, 1)
	go func() {
		stopped, _ := runUntilHandedOver(ctx, run, handedOver, 50*time.Millisecond)
		done <- stopped
	}()
	time.Sleep(20 * time.Millisecond)
	started := time.Now()
	close(handedOver)
	cancel()
	select {
	case stopped := <-done:
		if !stopped {
			t.Fatal("reported the lifecycle as returned while it was still closing")
		}
		if took := time.Since(started); took > time.Second {
			t.Fatalf("returned %s after the handover, want about the 50ms wait", took)
		}
	case <-time.After(time.Second):
		t.Fatal("waited for the control session to close after the handover")
	}
}

func TestRunReturnsTheLifecycleResult(t *testing.T) {
	failed := errors.New("fatal: node removed")
	t.Run("before a handover", func(t *testing.T) {
		stopped, err := runUntilHandedOver(context.Background(), func(context.Context) error { return failed }, make(chan struct{}), time.Hour)
		if stopped || !errors.Is(err, failed) {
			t.Fatalf("got stopped=%v err=%v, want the lifecycle error", stopped, err)
		}
	})
	t.Run("closing in time after a handover", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		handedOver := make(chan struct{})
		close(handedOver)
		cancel()
		stopped, err := runUntilHandedOver(ctx, func(ctx context.Context) error {
			<-ctx.Done()
			return failed
		}, handedOver, time.Hour)
		if stopped || !errors.Is(err, failed) {
			t.Fatalf("got stopped=%v err=%v, want the lifecycle result", stopped, err)
		}
	})
}
