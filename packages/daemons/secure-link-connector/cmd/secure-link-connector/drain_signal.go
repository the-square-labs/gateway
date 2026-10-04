package main

import (
	"context"
	"os"
	"syscall"
)

// drainSignal tells a connector to stop accepting, keeping its sessions (as a drain request does).
const drainSignal = syscall.SIGUSR1

// drainOnSignal drains once a drain signal arrives.
func drainOnSignal(ctx context.Context, signals <-chan os.Signal, drain func()) {
	select {
	case <-ctx.Done():
	case <-signals:
		drain()
	}
}
