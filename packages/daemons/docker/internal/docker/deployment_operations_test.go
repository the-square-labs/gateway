package docker

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestCancelDeploymentOperationInterruptsCurrentOperation(t *testing.T) {
	plugin := &DockerPlugin{}
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

func deploymentCommand(t *testing.T, action string, dep deploymentSnapshot) *pb.DockerDeploymentCommand {
	t.Helper()
	config, err := json.Marshal(deploymentCommandPayload{DeploymentID: dep.ID, Force: true, Deployment: dep})
	if err != nil {
		t.Fatal(err)
	}
	return &pb.DockerDeploymentCommand{Action: action, DeploymentId: dep.ID, ConfigJson: string(config)}
}

func runDeploymentCommand(plugin *DockerPlugin, cmd *pb.DockerDeploymentCommand) <-chan *pb.CommandResult {
	done := make(chan *pb.CommandResult, 1)
	go func() {
		result := &pb.CommandResult{Success: true}
		plugin.handleDeploymentCommand(cmd, result)
		done <- result
	}()
	return done
}

func awaitDeploymentResult(t *testing.T, done <-chan *pb.CommandResult) *pb.CommandResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("deployment command did not finish")
		return nil
	}
}

// blockFirstStop makes the first stop of name hang in the engine until release
// is closed, and reports on entered when it is reached.
func blockFirstStop(engine *fakeDockerEngine, name string) (entered chan struct{}, release chan struct{}) {
	entered = make(chan struct{})
	release = make(chan struct{})
	var once sync.Once
	engine.onStop = func(ctr *fakeContainer) {
		if ctr.Name != name {
			return
		}
		blocked := false
		once.Do(func() { blocked = true })
		if blocked {
			close(entered)
			<-release
		}
	}
	return entered, release
}

func secondDeploymentSnapshot() deploymentSnapshot {
	dep := testDeploymentSnapshot("blue")
	dep.ID = "dep-2"
	dep.RouterName = "gwdep-dep-2-router"
	dep.Slots[0].ContainerName = "gwdep-dep-2-blue"
	dep.Slots[1].ContainerName = "gwdep-dep-2-green"
	return dep
}

func TestDeploymentCommandsAreSerializedPerDeployment(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	for _, name := range []string{"gwdep-dep-1-router", "gwdep-dep-1-blue", "gwdep-dep-1-green", "gwdep-dep-2-router", "gwdep-dep-2-blue", "gwdep-dep-2-green"} {
		engine.addContainer(&fakeContainer{Name: name, Running: true})
	}
	entered, release := blockFirstStop(engine, "gwdep-dep-1-router")
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	plugin := &DockerPlugin{client: client}
	dep := testDeploymentSnapshot("blue")

	first := runDeploymentCommand(plugin, deploymentCommand(t, "stop", dep))
	<-entered
	retry := runDeploymentCommand(plugin, deploymentCommand(t, "stop", dep))

	// Another deployment is not held up by dep-1.
	if result := awaitDeploymentResult(t, runDeploymentCommand(plugin, deploymentCommand(t, "stop", secondDeploymentSnapshot()))); !result.Success {
		t.Fatalf("stop of another deployment failed: %s", result.Error)
	}
	time.Sleep(50 * time.Millisecond)
	if calls := engine.countCalls("POST /containers/gwdep-dep-1-router/stop"); calls != 1 {
		t.Fatalf("router stop calls while the first stop runs = %d, want 1 (the retry must wait)", calls)
	}

	close(release)
	for _, done := range []<-chan *pb.CommandResult{first, retry} {
		if result := awaitDeploymentResult(t, done); !result.Success {
			t.Fatalf("stop failed: %s", result.Error)
		}
	}
	if calls := engine.countCalls("POST /containers/gwdep-dep-1-router/stop"); calls != 2 {
		t.Fatalf("router stop calls = %d, want 2", calls)
	}
}

func TestDeploymentKillCancelsQueuedOperations(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	for _, name := range []string{"gwdep-dep-1-router", "gwdep-dep-1-blue", "gwdep-dep-1-green"} {
		engine.addContainer(&fakeContainer{Name: name, Running: true})
	}
	entered, release := blockFirstStop(engine, "gwdep-dep-1-router")
	defer close(release)
	plugin := &DockerPlugin{client: client}
	dep := testDeploymentSnapshot("blue")

	running := runDeploymentCommand(plugin, deploymentCommand(t, "stop", dep))
	<-entered
	queued := runDeploymentCommand(plugin, deploymentCommand(t, "restart", dep))
	time.Sleep(50 * time.Millisecond)

	if result := awaitDeploymentResult(t, runDeploymentCommand(plugin, deploymentCommand(t, "kill", dep))); !result.Success {
		t.Fatalf("kill failed: %s", result.Error)
	}
	if result := awaitDeploymentResult(t, running); result.Success {
		t.Fatal("the running stop should have been cancelled by the kill")
	}
	result := awaitDeploymentResult(t, queued)
	if result.Success || !strings.Contains(result.Error, "cancelled while waiting for another operation") {
		t.Fatalf("queued restart result = %+v, want it cancelled before running", result)
	}
	if calls := engine.countCalls("POST /containers/gwdep-dep-1-blue/restart"); calls != 0 {
		t.Fatalf("the queued restart ran after the kill (%d restart calls)", calls)
	}
	for _, name := range []string{"gwdep-dep-1-router", "gwdep-dep-1-blue", "gwdep-dep-1-green"} {
		if engine.countCalls("POST /containers/"+name+"/kill") != 1 {
			t.Fatalf("%s was not killed; calls: %v", name, engine.callLog())
		}
	}
}
