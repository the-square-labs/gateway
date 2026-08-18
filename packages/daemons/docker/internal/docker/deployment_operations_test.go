package docker

import (
	"context"
	"testing"
	"time"
)

func TestCancelDeploymentOperationInterruptsCurrentOperation(t *testing.T) {
	plugin := &DockerPlugin{deploymentOps: make(map[string]deploymentOperation)}
	ctx, finish := plugin.beginDeploymentOperation("deployment-1")

	settled := make(chan bool, 1)
	go func() {
		settled <- plugin.cancelDeploymentOperationAndWait("deployment-1", time.Second)
	}()
	select {
	case <-ctx.Done():
		if ctx.Err() != context.Canceled {
			t.Fatalf("unexpected context error: %v", ctx.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("deployment operation context was not cancelled")
	}
	select {
	case <-settled:
		t.Fatal("cancellation returned before the deployment operation stopped")
	case <-time.After(20 * time.Millisecond):
	}
	finish()
	if !<-settled {
		t.Fatal("expected cancelled deployment operation to settle")
	}
}
