package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

type sessionTestPlugin struct {
	composeStarted chan struct{}
	releaseCompose chan struct{}
}

func (p *sessionTestPlugin) Type() string                                      { return "docker" }
func (p *sessionTestPlugin) Init(*BaseConfig, *slog.Logger) error              { return nil }
func (p *sessionTestPlugin) CollectHealth(b *pb.HealthReport) *pb.HealthReport { return b }
func (p *sessionTestPlugin) CollectStats() *pb.StatsReport                     { return nil }
func (p *sessionTestPlugin) OnSessionStart(context.Context, *stream.Writer) error {
	return nil
}
func (p *sessionTestPlugin) OnSessionEnd()          {}
func (p *sessionTestPlugin) SetLogger(*slog.Logger) {}
func (p *sessionTestPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	return &pb.RegisterMessage{NodeId: nodeID, DaemonType: "docker"}
}

func (p *sessionTestPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	if compose := cmd.GetDockerCompose(); compose != nil && compose.GetAction() == "apply" {
		p.composeStarted <- struct{}{}
		<-p.releaseCompose
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
}

type sessionTestControlServer struct {
	pb.UnimplementedNodeControlServer
	run func(pb.NodeControl_CommandStreamServer) error
}

func (s *sessionTestControlServer) CommandStream(commandStream pb.NodeControl_CommandStreamServer) error {
	return s.run(commandStream)
}

func startSessionTestServer(t *testing.T, run func(pb.NodeControl_CommandStreamServer) error) *grpc.ClientConn {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterNodeControlServer(server, &sessionTestControlServer{run: run})
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func newSessionTestDaemon(plugin DaemonPlugin) *DaemonBase {
	handler := slog.NewTextHandler(io.Discard, nil)
	return &DaemonBase{
		cfg:                   &BaseConfig{},
		state:                 &state.State{NodeID: "11111111-1111-4111-8111-111111111111"},
		plugin:                plugin,
		sysReporter:           newSystemReporter(),
		logger:                slog.New(handler),
		baseHandler:           handler,
		tunnelIdentityChanged: make(chan struct{}, 1),
	}
}

// awaitCommandResult reads daemon messages until the result for commandID.
func awaitCommandResult(t *testing.T, commandStream pb.NodeControl_CommandStreamServer, commandID string) *pb.CommandResult {
	t.Helper()
	for {
		message, err := commandStream.Recv()
		if err != nil {
			t.Errorf("waiting for %s: %v", commandID, err)
			return nil
		}
		if result := message.GetCommandResult(); result != nil && result.CommandId == commandID {
			return result
		}
	}
}

func TestSessionHandlesComposeCancelAndExpiredCommandsWhileComposeRuns(t *testing.T) {
	plugin := &sessionTestPlugin{composeStarted: make(chan struct{}, 1), releaseCompose: make(chan struct{})}
	serverDone := make(chan struct{})
	conn := startSessionTestServer(t, func(commandStream pb.NodeControl_CommandStreamServer) error {
		defer close(serverDone)
		if message, err := commandStream.Recv(); err != nil || message.GetRegister() == nil {
			t.Errorf("first message = %v, %v; want register", message, err)
			return nil
		}
		compose := func(id, action string) *pb.GatewayCommand {
			return &pb.GatewayCommand{CommandId: id, SentAtUnixMs: time.Now().UnixMilli(), Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: &pb.DockerComposeCommand{Action: action, OperationId: "op-1", ProjectId: "project-1"}}}
		}
		if err := commandStream.Send(compose("apply-1", "apply")); err != nil {
			return err
		}
		select {
		case <-plugin.composeStarted:
		case <-time.After(3 * time.Second):
			t.Error("compose apply did not start")
			return nil
		}
		// The receive loop must stay responsive while the apply runs.
		if err := commandStream.Send(compose("cancel-1", "cancel")); err != nil {
			return err
		}
		if result := awaitCommandResult(t, commandStream, "cancel-1"); result != nil && !result.Success {
			t.Errorf("cancel result = %+v", result)
		}
		// Sent two minutes ago by the gateway clock and delivered only now,
		// while the earlier commands arrived at once.
		expired := &pb.GatewayCommand{
			CommandId:       "expired-1",
			SentAtUnixMs:    time.Now().Add(-2 * time.Minute).UnixMilli(),
			ExpiresAtUnixMs: time.Now().Add(-time.Minute).UnixMilli(),
			Payload:         &pb.GatewayCommand_ApplyConfig{ApplyConfig: &pb.ApplyConfigCommand{}},
		}
		if err := commandStream.Send(expired); err != nil {
			return err
		}
		if result := awaitCommandResult(t, commandStream, "expired-1"); result != nil && (result.Success || !strings.Contains(result.Error, "expired")) {
			t.Errorf("expired command result = %+v", result)
		}
		close(plugin.releaseCompose)
		if result := awaitCommandResult(t, commandStream, "apply-1"); result != nil && !result.Success {
			t.Errorf("apply result = %+v", result)
		}
		return nil
	})

	daemon := newSessionTestDaemon(plugin)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sessionDone := make(chan error, 1)
	go func() { sessionDone <- runSession(ctx, conn, daemon) }()

	select {
	case <-serverDone:
	case <-time.After(8 * time.Second):
		t.Fatal("gateway side of the session did not finish")
	}
	select {
	case <-sessionDone:
	case <-time.After(3 * time.Second):
		t.Fatal("session did not end after the gateway closed the stream")
	}
	if !daemon.sessionReceivedCommand {
		t.Fatal("session did not record that the gateway accepted it")
	}
}

func TestSessionReturnsRegistrationRejection(t *testing.T) {
	plugin := &sessionTestPlugin{composeStarted: make(chan struct{}, 1), releaseCompose: make(chan struct{})}
	conn := startSessionTestServer(t, func(commandStream pb.NodeControl_CommandStreamServer) error {
		if _, err := commandStream.Recv(); err != nil {
			return err
		}
		return commandStream.Send(&pb.GatewayCommand{
			CommandId: registrationRejectedCommandID,
			Payload:   &pb.GatewayCommand_ApplyConfig{ApplyConfig: &pb.ApplyConfigCommand{ConfigContent: "node was removed"}},
		})
	})

	daemon := newSessionTestDaemon(plugin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runSession(ctx, conn, daemon)
	rejected, ok := err.(*RegistrationRejectedError)
	if !ok || rejected.Message != "node was removed" {
		t.Fatalf("runSession error = %v, want registration rejection", err)
	}
	if daemon.sessionReceivedCommand {
		t.Fatal("a rejection must not count as an accepted session")
	}
}

func TestControlSessionBackoffGrowsOnlyForQuickUnacceptedSessions(t *testing.T) {
	var backoff controlSessionBackoff
	var delays []time.Duration
	for i := 0; i < 8; i++ {
		delays = append(delays, backoff.next(false, 100*time.Millisecond))
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 60 * time.Second, 60 * time.Second}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("delays = %v, want %v", delays, want)
		}
	}
	if delay := backoff.next(true, 100*time.Millisecond); delay != time.Second {
		t.Fatalf("delay after an accepted session = %v, want 1s", delay)
	}
	if delay := backoff.next(false, time.Minute); delay != time.Second {
		t.Fatalf("delay after a long session = %v, want 1s", delay)
	}
	if first, second := backoff.nextRejected(), backoff.nextRejected(); first != time.Minute || second != 2*time.Minute {
		t.Fatalf("rejection delays = %v, %v", first, second)
	}
	for i := 0; i < 10; i++ {
		backoff.nextRejected()
	}
	if delay := backoff.nextRejected(); delay != 30*time.Minute {
		t.Fatalf("rejection delay cap = %v", delay)
	}
}

func TestCommandExpiryToleratesDelayJitter(t *testing.T) {
	clock := newCommandClock()
	now := clock.base
	first := &pb.GatewayCommand{SentAtUnixMs: now.UnixMilli(), ExpiresAtUnixMs: now.Add(10 * time.Second).UnixMilli()}
	clock.observe(first, now)
	if clock.expired(first, now) {
		t.Fatal("a command delivered at once must run")
	}
	late := &pb.GatewayCommand{SentAtUnixMs: now.Add(-12 * time.Second).UnixMilli(), ExpiresAtUnixMs: now.Add(-2 * time.Second).UnixMilli()}
	clock.observe(late, now)
	if clock.expired(late, now) {
		t.Fatal("a command within the tolerance must still run")
	}
	stale := &pb.GatewayCommand{SentAtUnixMs: now.Add(-2 * time.Minute).UnixMilli(), ExpiresAtUnixMs: now.Add(-time.Minute).UnixMilli()}
	clock.observe(stale, now)
	if !clock.expired(stale, now) {
		t.Fatal("a command delivered well past its deadline must be dropped")
	}
}

func TestCommandExpiryIgnoresClockSkew(t *testing.T) {
	// This host's clock runs 16s ahead of the gateway; every 10s command
	// arrives promptly and must run.
	clock := newCommandClock()
	for i := 0; i < 3; i++ {
		received := clock.base.Add(time.Duration(i) * time.Second)
		gatewayNow := received.Add(-16 * time.Second)
		cmd := &pb.GatewayCommand{SentAtUnixMs: gatewayNow.UnixMilli(), ExpiresAtUnixMs: gatewayNow.Add(10 * time.Second).UnixMilli()}
		clock.observe(cmd, received)
		if clock.expired(cmd, received) {
			t.Fatalf("command %d expired on a host whose clock runs ahead", i)
		}
	}
	// And one that sat 30s in delivery is still dropped despite the skew.
	received := clock.base.Add(40 * time.Second)
	sentAt := received.Add(-16*time.Second - 30*time.Second)
	stale := &pb.GatewayCommand{SentAtUnixMs: sentAt.UnixMilli(), ExpiresAtUnixMs: sentAt.Add(10 * time.Second).UnixMilli()}
	clock.observe(stale, received)
	if !clock.expired(stale, received) {
		t.Fatal("a command delivered 30s late must be dropped")
	}

	// A host 16s behind is not lenient forever either.
	behind := newCommandClock()
	prompt := &pb.GatewayCommand{SentAtUnixMs: behind.base.Add(16 * time.Second).UnixMilli(), ExpiresAtUnixMs: behind.base.Add(26 * time.Second).UnixMilli()}
	behind.observe(prompt, behind.base)
	if behind.expired(prompt, behind.base) {
		t.Fatal("a prompt command expired on a host whose clock runs behind")
	}
}

func TestCommandExpirySkippedWithoutSendTime(t *testing.T) {
	clock := newCommandClock()
	now := clock.base
	if clock.expired(&pb.GatewayCommand{}, now) {
		t.Fatal("a command without a deadline must never expire")
	}
	oldGateway := &pb.GatewayCommand{ExpiresAtUnixMs: now.Add(-time.Hour).UnixMilli()}
	clock.observe(oldGateway, now)
	if clock.expired(oldGateway, now) {
		t.Fatal("a deadline without a send time must not be judged against the local clock")
	}
	if _, ok := clock.remaining(oldGateway, now); ok {
		t.Fatal("a deadline without a send time must not bound a slot wait")
	}
}
