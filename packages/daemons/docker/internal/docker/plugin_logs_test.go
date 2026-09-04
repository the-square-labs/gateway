package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
)

type logCommandRecorder struct {
	pb.NodeControl_CommandStreamClient
	mu       sync.Mutex
	messages []*pb.DaemonMessage
}

func (r *logCommandRecorder) Send(message *pb.DaemonMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.messages = append(r.messages, message)
	return nil
}

func (r *logCommandRecorder) snapshot() []*pb.DaemonMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*pb.DaemonMessage(nil), r.messages...)
}

type gatedLogReader struct {
	reader  *bytes.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *gatedLogReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.release
	return r.reader.Read(p)
}

func (r *gatedLogReader) Close() error { return nil }

func logTestFrame(line string) []byte {
	header := make([]byte, 8)
	header[0] = 1
	binary.BigEndian.PutUint32(header[4:], uint32(len(line)))
	return append(header, line...)
}

func waitLogTest(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("log test did not finish")
	}
}

func TestSupersededLogStreamDoesNotEmitOrRemoveReplacement(t *testing.T) {
	for _, payload := range []string{"", "stale data\n"} {
		t.Run(payload, func(t *testing.T) {
			recorder := &logCommandRecorder{}
			p := &DockerPlugin{writer: stream.NewWriter(recorder), logger: slog.Default(), logStreamCancel: make(map[string]context.CancelFunc)}
			oldCtx, oldCancel := context.WithCancel(context.Background())
			defer oldCancel()
			newCtx, newCancel := context.WithCancel(context.Background())
			defer newCancel()
			var data []byte
			if payload != "" {
				data = logTestFrame(payload)
			}
			reader := &gatedLogReader{reader: bytes.NewReader(data), started: make(chan struct{}), release: make(chan struct{})}
			p.registerLogStream(oldCtx, oldCancel, "container")
			done := make(chan struct{})
			go func() {
				p.streamLogs(oldCtx, oldCancel, "container", reader)
				close(done)
			}()
			waitLogTest(t, reader.started)
			p.registerLogStream(newCtx, newCancel, "container")
			close(reader.release)
			waitLogTest(t, done)
			if messages := recorder.snapshot(); len(messages) != 0 {
				t.Fatalf("superseded stream sent %d messages", len(messages))
			}
			p.stopLogStream("container")
			if newCtx.Err() != context.Canceled {
				t.Fatal("old cleanup removed the replacement cancel function")
			}
			p.releaseLogStream(newCtx, newCancel, "container")
		})
	}
}

func TestCurrentLogStreamEmitsDataAndEndAndReleasesOwnership(t *testing.T) {
	recorder := &logCommandRecorder{}
	p := &DockerPlugin{writer: stream.NewWriter(recorder), logger: slog.Default(), logStreamCancel: make(map[string]context.CancelFunc)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.registerLogStream(ctx, cancel, "container")
	p.streamLogs(ctx, cancel, "container", io.NopCloser(bytes.NewReader(logTestFrame("fresh\n"))))
	messages := recorder.snapshot()
	if len(messages) != 2 {
		t.Fatalf("messages = %d, want fresh data and natural end", len(messages))
	}
	for index, message := range messages {
		result := message.GetCommandResult()
		if result.CommandId != "log_stream:container" || !result.Success {
			t.Fatalf("changed log result identity: %v", result)
		}
		var event struct {
			Type        string   `json:"type"`
			ContainerID string   `json:"containerId"`
			Lines       []string `json:"lines"`
			Ended       bool     `json:"ended"`
		}
		if err := json.Unmarshal([]byte(result.Detail), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "log_stream" || event.ContainerID != "container" || event.Ended != (index == 1) {
			t.Fatalf("unexpected log event: %+v", event)
		}
		if index == 0 && (len(event.Lines) != 1 || event.Lines[0] != "fresh") {
			t.Fatalf("unexpected log data: %+v", event)
		}
	}
	if len(p.logStreamCancel) != 0 || ctx.Err() != context.Canceled {
		t.Fatal("completed current stream retained ownership")
	}
	if _, exists := logStreamOwners.Load(logStreamOwnerKey{p, "container"}); exists {
		t.Fatal("completed stream retained its private ownership token")
	}
}

func TestLogReplacementSurvivesSharedMapDeferredCancel(t *testing.T) {
	recorder := &logCommandRecorder{}
	p := &DockerPlugin{writer: stream.NewWriter(recorder), logger: slog.Default(), logStreamCancel: make(map[string]context.CancelFunc)}
	oldCtx, oldCancel := context.WithCancel(context.Background())
	defer oldCancel()
	newCtx, newCancel := context.WithCancel(context.Background())
	defer newCancel()
	p.registerLogStream(oldCtx, oldCancel, "container")
	// Managed database stop takes the cancel function under this lock, then
	// calls it after unlocking. Replace the stream in that exact interval.
	p.logStreamMu.Lock()
	delayedCancel := p.logStreamCancel["container"]
	delete(p.logStreamCancel, "container")
	p.logStreamMu.Unlock()
	p.registerLogStream(newCtx, newCancel, "container")
	if oldCtx.Err() != context.Canceled {
		t.Fatal("replacement orphaned the stream removed from the shared map")
	}
	p.streamLogs(oldCtx, oldCancel, "container", io.NopCloser(bytes.NewReader(nil)))
	delayedCancel()
	if newCtx.Err() != nil {
		t.Fatal("deferred old cancellation canceled the replacement")
	}
	if len(recorder.snapshot()) != 0 {
		t.Fatal("old shared-map stream emitted after replacement")
	}
	p.stopLogStream("container")
	if newCtx.Err() != context.Canceled {
		t.Fatal("old shared-map cleanup deleted the replacement")
	}
	p.releaseLogStream(newCtx, newCancel, "container")
}

type logTestTransport func(*http.Request) (*http.Response, error)

func (f logTestTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type blockedLogCommandStream struct {
	pb.NodeControl_CommandStreamClient
	started chan struct{}
	release chan struct{}
	once    sync.Once
	calls   int
}

func (s *blockedLogCommandStream) Send(*pb.DaemonMessage) error {
	s.calls++
	s.once.Do(func() { close(s.started) })
	<-s.release
	return nil
}

func TestLogStreamBlockedWriterDoesNotBlockReplacementOrStop(t *testing.T) {
	blocked := &blockedLogCommandStream{started: make(chan struct{}), release: make(chan struct{})}
	unblock := sync.OnceFunc(func() { close(blocked.release) })
	p := &DockerPlugin{writer: stream.NewWriter(blocked), logger: slog.Default(), logStreamCancel: make(map[string]context.CancelFunc)}
	oldCtx, oldCancel := context.WithCancel(context.Background())
	defer oldCancel()
	newCtx, newCancel := context.WithCancel(context.Background())
	defer newCancel()
	p.registerLogStream(oldCtx, oldCancel, "container")
	streamDone := make(chan struct{})
	go func() {
		p.streamLogs(oldCtx, oldCancel, "container", io.NopCloser(bytes.NewReader(logTestFrame("in flight\n"))))
		close(streamDone)
	}()
	defer func() {
		unblock()
		waitLogTest(t, streamDone)
		p.releaseLogStream(newCtx, newCancel, "container")
	}()
	waitLogTest(t, blocked.started)
	lifecycleDone := make(chan struct{})
	go func() {
		p.registerLogStream(newCtx, newCancel, "container")
		p.stopLogStream("container")
		close(lifecycleDone)
	}()
	// Both lifecycle calls must complete before allowing gRPC Send to return.
	waitLogTest(t, lifecycleDone)
	if oldCtx.Err() != context.Canceled || newCtx.Err() != context.Canceled {
		t.Fatal("replacement or stop failed to cancel its stream under backpressure")
	}
	unblock()
	waitLogTest(t, streamDone)
	if blocked.calls != 1 {
		t.Fatalf("canceled stream sent %d messages; only its in-flight send is allowed", blocked.calls)
	}
}

func TestOverlappingLogOpensCancelEarlierAndPreserveNewestOwner(t *testing.T) {
	for _, failEarlier := range []bool{false, true} {
		name := "late reader"
		if failEarlier {
			name = "failed reader"
		}
		t.Run(name, func(t *testing.T) {
			type opening struct {
				ctx     context.Context
				release chan bool
			}
			opened := make(chan opening, 2)
			cli, err := client.NewClientWithOpts(client.WithHost("http://docker.test"), client.WithVersion("1.54"),
				client.WithHTTPClient(&http.Client{Transport: logTestTransport(func(req *http.Request) (*http.Response, error) {
					request := opening{ctx: req.Context(), release: make(chan bool, 1)}
					opened <- request
					if <-request.release {
						return nil, errors.New("reader open failed")
					}
					// Match the real HTTP transport: a canceled open does not
					// return a successful body for the SDK to initialize.
					if err := req.Context().Err(); err != nil {
						return nil, err
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(nil)), Request: req}, nil
				})}))
			if err != nil {
				t.Fatal(err)
			}
			defer cli.Close()
			recorder := &logCommandRecorder{}
			p := &DockerPlugin{client: &Client{cli: cli}, writer: stream.NewWriter(recorder), logger: slog.Default(), logStreamCancel: make(map[string]context.CancelFunc)}
			start := func() <-chan struct{} {
				done := make(chan struct{})
				go func() {
					p.handleLogsCommand(&pb.DockerLogsCommand{ContainerId: "container", Follow: true}, &pb.CommandResult{Success: true})
					close(done)
				}()
				return done
			}
			nextOpen := func() opening {
				select {
				case request := <-opened:
					return request
				case <-time.After(3 * time.Second):
					t.Fatal("Docker reader open was not called")
					return opening{}
				}
			}
			firstDone := start()
			first := nextOpen()
			secondDone := start()
			second := nextOpen()
			if first.ctx.Err() != context.Canceled {
				t.Error("first open was not canceled before second reader open")
			}
			first.release <- failEarlier
			waitLogTest(t, firstDone)
			p.stopLogStream("container")
			if second.ctx.Err() != context.Canceled {
				t.Error("earlier reader completion removed the newer cancel function")
			}
			second.release <- false
			waitLogTest(t, secondDone)
			if messages := recorder.snapshot(); len(messages) != 0 {
				t.Fatalf("superseded/canceled opens emitted %d messages", len(messages))
			}
		})
	}
}
