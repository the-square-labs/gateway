package lifecycle

import (
	"context"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

type relayRenewalTestPlugin struct {
	sessionTestPlugin
	renewalStarted chan struct{}
	releaseRenewal chan struct{}
}

func (p *relayRenewalTestPlugin) Type() string { return "relay" }

func (p *relayRenewalTestPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	if cmd.GetRenewRelayIdentity() != nil {
		p.renewalStarted <- struct{}{}
		<-p.releaseRenewal
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
}

// A relay certificate renewal can take tens of seconds. Policy pushes for the
// same relay must not wait behind it until Gateway gives up on them.
func TestSessionHandlesRelayPolicyWhileARenewalRuns(t *testing.T) {
	plugin := &relayRenewalTestPlugin{renewalStarted: make(chan struct{}, 1), releaseRenewal: make(chan struct{})}
	serverDone := make(chan struct{})
	conn := startSessionTestServer(t, func(commandStream pb.NodeControl_CommandStreamServer) error {
		defer close(serverDone)
		if message, err := commandStream.Recv(); err != nil || message.GetRegister() == nil {
			t.Errorf("first message = %v, %v; want register", message, err)
			return nil
		}
		now := time.Now().UnixMilli()
		if err := commandStream.Send(&pb.GatewayCommand{CommandId: "renew-1", SentAtUnixMs: now, Payload: &pb.GatewayCommand_RenewRelayIdentity{RenewRelayIdentity: &pb.RenewRelayIdentityCommand{ServerIdentity: "relay-r2"}}}); err != nil {
			return err
		}
		select {
		case <-plugin.renewalStarted:
		case <-time.After(3 * time.Second):
			t.Error("renewal did not start")
			return nil
		}
		if err := commandStream.Send(&pb.GatewayCommand{CommandId: "policy-1", SentAtUnixMs: now, Payload: &pb.GatewayCommand_SyncRelayPolicy{SyncRelayPolicy: &pb.SyncRelayPolicyCommand{}}}); err != nil {
			return err
		}
		if result := awaitCommandResult(t, commandStream, "policy-1"); result == nil || !result.Success {
			t.Errorf("policy result = %+v", result)
		}
		close(plugin.releaseRenewal)
		if result := awaitCommandResult(t, commandStream, "renew-1"); result == nil || !result.Success {
			t.Errorf("renewal result = %+v", result)
		}
		return nil
	})
	daemon := newSessionTestDaemon(plugin)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = runSession(ctx, conn, daemon) }()
	select {
	case <-serverDone:
	case <-time.After(8 * time.Second):
		t.Fatal("the policy push waited behind the renewal")
	}
}
