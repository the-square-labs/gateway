package relayresume

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Stream is one relay tunnel stream (OpenTunnel or AcceptTunnel).
type Stream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

// OpenedPath is a tunnel the relay admitted (its Ready frame was read).
type OpenedPath struct {
	Stream Stream
	// Cancel ends the stream (its context).
	Cancel func()
	// CloseSend half-closes the stream, when the stream supports it.
	CloseSend func() error
	RelayID   string
	MaxFrame  int
	// Generation is the driver's label of the path: the assignment generation
	// of the grant it was opened with (0 unknown). Planned moves pass it back
	// in DialRequest.FromGeneration.
	Generation uint64
}

type queued struct {
	frame  []byte
	pooled bool
}

// pathRun is the driver state of one path.
type pathRun struct {
	path   *Path
	op     OpenedPath
	queue  []queued // frames to send, in order
	close  bool     // close once the queue is sent
	sendMu sync.Mutex
	done   chan struct{} // closed once the stream is cancelled and the reader ended
	// readerBusy: someone (the bridge's Recv or the background reader) is in
	// Recv on this stream.
	readerBusy bool
	bgWaiting  bool
	reader     chan struct{} // closed when the reader goroutine exits
	// closing: closeRun owns the path's end; flushed closes once its queue
	// was sent (or failed).
	closing   bool
	flushed   chan struct{}
	flushOnce sync.Once
}

// Session drives a Core over real relay streams. It implements the
// relaybridge FrameStream interface (Send and Recv of Data, HalfClose and
// Close frames) for the bridges, which work unchanged on top of it.
type Session struct {
	mu sync.Mutex
	// readCond wakes Recv, writeCond wakes Write, stateCond wakes the
	// migration worker; each only when its waiter can make progress.
	readCond, writeCond, stateCond *sync.Cond
	readers, writers               int
	bgCond                         *sync.Cond // background readers wait for the stream
	inRecv, recvGone, bgArmed      bool
	recvExit                       time.Time
	recvFrame                      *relayv1.TunnelFrame
	recvData                       *relayv1.TunnelData
	bgTimer                        *time.Timer
	lastUna                        uint64
	lastState                      State
	lastPending                    *Path
	lastCur                        *Path
	core                           *Core
	paths                          map[*Path]*pathRun
	timer                          *time.Timer
	armedAt                        time.Time

	// The largest Data payload Recv hands out (the first path's frame size,
	// which the bridges were given).
	recvMax int
	partial []byte

	done     chan struct{}
	doneOnce sync.Once

	// Source side.
	source   *sourceState
	onChange func(*Session) // the target table watches its sessions

	routeID string
	tag     any
}

func newSession(core *Core, routeID string, recvMax int) *Session {
	if recvMax <= 0 || recvMax > MaxFrameBytes {
		recvMax = MaxFrameBytes
	}
	// The bridges read and receive at most MaxFrame bytes: one read is one
	// DATA frame on a path with the first path's frame size.
	s := &Session{core: core, paths: map[*Path]*pathRun{}, done: make(chan struct{}), routeID: routeID, recvMax: ReadChunk(recvMax)}
	s.readCond, s.writeCond, s.stateCond, s.bgCond = sync.NewCond(&s.mu), sync.NewCond(&s.mu), sync.NewCond(&s.mu), sync.NewCond(&s.mu)
	// Until a bridge calls Recv the background reader reads (the handshake
	// answer must be read even if nobody receives yet).
	s.recvExit = time.Now()
	s.armGraceLocked(readGrace)
	return s
}

// attach registers a path and starts its reader. Called with mu held.
func (s *Session) attach(path *Path, op OpenedPath) *pathRun {
	run := &pathRun{path: path, op: op, done: make(chan struct{}), reader: make(chan struct{}), flushed: make(chan struct{})}
	s.paths[path] = run
	go s.read(run)
	return run
}

// readGrace is how long the bridge may stay out of Recv before the path's
// own reader takes the stream over (acks of the other direction must not
// wait behind a slow local socket).
const readGrace = 2 * time.Millisecond

// read is the path's background reader. The bridge's Recv reads the current
// path itself while it keeps calling (no goroutine handoff per frame); this
// reader takes over when the bridge stays away longer than readGrace (a
// slow local socket, the peer's FIN delivered) and always reads paths that
// are not current. It never blocks on a send, so both peers always drain
// their inbound streams and gRPC flow control cannot deadlock.
func (s *Session) read(run *pathRun) {
	defer close(run.reader)
	s.mu.Lock()
	for {
		for !run.path.Closed() && !s.backgroundMayRead(run) {
			run.bgWaiting = true
			s.bgCond.Wait()
			run.bgWaiting = false
		}
		if run.path.Closed() {
			s.mu.Unlock()
			return
		}
		run.readerBusy = true
		s.mu.Unlock()
		frame, err := run.op.Stream.Recv()
		s.mu.Lock()
		run.readerBusy = false
		s.handleFrameLocked(run, frame, err)
	}
}

// backgroundMayRead: the path is free and the bridge is not about to read it.
func (s *Session) backgroundMayRead(run *pathRun) bool {
	if run.readerBusy {
		return false
	}
	if run.path != s.core.Current() || s.recvGone {
		return true
	}
	return !s.inRecv && time.Since(s.recvExit) >= readGrace
}

// handleFrameLocked processes what a path read returned (mu held).
func (s *Session) handleFrameLocked(run *pathRun, frame *relayv1.TunnelFrame, err error) {
	if run.path.Closed() {
		s.bgCond.Broadcast()
		return
	}
	now := time.Now()
	if err != nil {
		s.core.PathFailed(run.path, terminalPathError(err), err, now)
	} else {
		switch payload := frame.Payload.(type) {
		case *relayv1.TunnelFrame_Data:
			if len(payload.Data.GetData()) == 0 {
				s.core.Abort(RstProtocol, "empty data frame", ErrProtocol)
			} else {
				s.core.PathFrame(run.path, payload.Data.GetData(), now)
			}
		case *relayv1.TunnelFrame_Error:
			code := payload.Error.GetCode()
			s.core.PathFailed(run.path, s.core.State() == StateHandshake, fmt.Errorf("relay tunnel error: %s", code), now)
		default:
			// Close, HalfClose or anything else: this path is over.
			s.core.PathFailed(run.path, false, errors.New("relay tunnel ended"), now)
		}
	}
	s.afterLocked(true)
	// The stream is free again: wake this path's background reader only if
	// it may take it now (not on every frame the bridge reads itself).
	if run.bgWaiting && s.backgroundMayRead(run) {
		s.bgCond.Broadcast()
	}
	if s.readers > 0 {
		s.readCond.Signal()
	}
}

// recvExitLocked notes that the bridge left Recv; the background reader
// takes over if it does not come back within readGrace.
func (s *Session) recvExitLocked(gone bool) {
	s.inRecv = false
	s.recvExit = time.Now()
	if gone {
		s.recvGone = true
		s.bgCond.Broadcast()
		return
	}
	// One armed timer at a time (not a reset per frame): when it fires
	// it checks how long the bridge has been away.
	if !s.bgArmed {
		s.armGraceLocked(readGrace)
	}
}

func (s *Session) armGraceLocked(after time.Duration) {
	s.bgArmed = true
	if s.bgTimer == nil {
		s.bgTimer = time.AfterFunc(after, s.graceCheck)
	} else {
		s.bgTimer.Reset(after)
	}
}

func (s *Session) graceCheck() {
	s.mu.Lock()
	s.bgArmed = false
	if !s.inRecv {
		if away := time.Since(s.recvExit); away >= readGrace {
			s.bgCond.Broadcast()
		} else {
			s.armGraceLocked(readGrace - away)
		}
	}
	s.mu.Unlock()
}

// terminalPathError reports relay verdicts that end the stream itself: the
// relay's idle and half-close timeouts and refused frames. Everything else
// (transport loss, GOAWAY, a forced disconnect, a revocation) is resumable;
// the target rechecks authorization on resume.
func terminalPathError(err error) bool {
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.DeadlineExceeded:
		return strings.Contains(current.Message(), "idle timeout") || strings.Contains(current.Message(), "half-close timeout")
	case codes.InvalidArgument:
		return true
	}
	return false
}

// afterLocked moves outputs to the paths, rearms the timer and wakes
// waiters. async: the caller is a reader, which must not block on sends.
// Called with mu held; it may release and retake mu.
func (s *Session) afterLocked(async bool) {
	var kick []*pathRun
	for _, out := range s.core.TakeOutputs() {
		run := s.paths[out.Path]
		if run == nil {
			continue
		}
		if out.Close {
			run.close = true
			s.bgCond.Broadcast()
			if !run.closing {
				// A given-up path ends on its own: its last records get a
				// short time to leave, then it is cancelled even if a send
				// on it is stuck (a stream nobody reads any more).
				run.closing = true
				go s.closeRun(run)
			}
		} else {
			run.queue = append(run.queue, queued{out.Frame, out.Pooled})
		}
		if len(kick) == 0 || kick[len(kick)-1] != run {
			kick = append(kick, run)
		}
	}
	s.armLocked()
	s.wakeLocked()
	if s.core.State().Terminal() {
		s.doneOnce.Do(func() { close(s.done) })
	}
	if s.source != nil {
		s.source.observeLocked(s)
	}
	if s.onChange != nil {
		s.onChange(s)
	}
	if len(kick) == 0 {
		return
	}
	if async {
		for _, run := range kick {
			go s.drain(run)
		}
		return
	}
	// The caller (a writer, a resume) waits for the live paths only: a path
	// being given up drains on its own goroutine, so a send stuck on it
	// never holds back another path's frames (a RESUME_ACK).
	var live []*pathRun
	for _, run := range kick {
		if run.close {
			go s.drain(run)
		} else {
			live = append(live, run)
		}
	}
	if len(live) == 0 {
		return
	}
	s.mu.Unlock()
	for _, run := range live {
		s.drain(run)
	}
	s.mu.Lock()
}

// drain sends a path's queued frames in order; one drainer per path at a
// time.
func (s *Session) drain(run *pathRun) {
	run.sendMu.Lock()
	defer run.sendMu.Unlock()
	for {
		s.mu.Lock()
		if len(run.queue) == 0 {
			if run.close {
				run.flushOnce.Do(func() { close(run.flushed) })
			}
			s.mu.Unlock()
			return
		}
		item := run.queue[0]
		run.queue[0] = queued{}
		run.queue = run.queue[1:]
		s.mu.Unlock()
		err := run.op.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: item.frame}}})
		if item.pooled {
			ReleaseFrame(item.frame)
		}
		if err != nil {
			s.mu.Lock()
			for _, item := range run.queue {
				if item.pooled {
					ReleaseFrame(item.frame)
				}
			}
			run.queue = nil
			if !run.path.Closed() {
				s.core.PathFailed(run.path, false, err, time.Now())
			}
			s.afterLocked(true)
			if run.close {
				run.flushOnce.Do(func() { close(run.flushed) })
			}
			s.mu.Unlock()
			return
		}
	}
}

// closeFlushTimeout bounds how long a given-up path's last records may take
// to leave before its stream is cancelled under a stuck send.
const closeFlushTimeout = 2 * time.Second

// closeRun ends a path's stream once the session gave it up: after its
// queued records left (or closeFlushTimeout), the source sends the relay
// Close of a finished stream, a target half-closes and lingers so its last
// record arrives, and the stream is cancelled.
func (s *Session) closeRun(run *pathRun) {
	go s.drain(run) // flushes what is queued, or reports an empty queue
	flushed := true
	select {
	case <-run.flushed:
	case <-time.After(closeFlushTimeout):
		flushed = false
	}
	s.mu.Lock()
	state := s.core.State()
	s.mu.Unlock()
	switch {
	case !flushed:
	case s.core.Role() == RoleSource:
		if state == StateFinished {
			// As the bridges always did: the relay ends the tunnel on Close.
			sent := make(chan struct{})
			go func() {
				_ = run.op.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
				close(sent)
			}()
			select {
			case <-sent:
			case <-time.After(closeFlushTimeout):
			}
		}
	case run.op.CloseSend != nil:
		// Let the last records (CLOSE echo, RST, RESUME_REJ) leave before the
		// stream is cancelled: the source ends the tunnel.
		_ = run.op.CloseSend()
		select {
		case <-run.reader:
		case <-time.After(CloseLingerTimeout):
		}
	}
	if run.op.Cancel != nil {
		run.op.Cancel()
	}
	<-run.reader
	s.mu.Lock()
	delete(s.paths, run.path)
	s.mu.Unlock()
	close(run.done)
}

func (s *Session) wakeLocked() {
	state := s.core.State()
	terminal := state.Terminal()
	if s.readers > 0 && (terminal || s.core.Readable() || len(s.partial) > 0) {
		s.readCond.Signal()
	}
	if una, _, _, _ := s.core.Offsets(); s.writers > 0 && (terminal || una != s.lastUna) {
		s.writeCond.Signal()
	}
	s.lastUna, _, _, _ = s.core.Offsets()
	if cur := s.core.Current(); cur != s.lastCur {
		s.lastCur = cur
		if s.readers > 0 {
			s.readCond.Signal()
		}
		s.bgCond.Broadcast()
	}
	if pending := s.core.Pending(); state != s.lastState || pending != s.lastPending {
		s.lastState, s.lastPending = state, pending
		s.stateCond.Broadcast()
	}
}

func (s *Session) armLocked() {
	next := s.core.NextDeadline()
	if next.Equal(s.armedAt) {
		return
	}
	s.armedAt = next
	if next.IsZero() {
		if s.timer != nil {
			s.timer.Stop()
		}
		return
	}
	delay := time.Until(next)
	if s.timer == nil {
		s.timer = time.AfterFunc(delay, s.tick)
		return
	}
	s.timer.Reset(delay)
}

func (s *Session) tick() {
	s.mu.Lock()
	s.armedAt = time.Time{}
	s.core.Tick(time.Now())
	s.afterLocked(false)
	s.mu.Unlock()
}

// Send takes a frame from a bridge: Data (owned by the session from now on),
// HalfClose (FIN) or Close (wait until the stream finished).
func (s *Session) Send(frame *relayv1.TunnelFrame) error {
	switch payload := frame.Payload.(type) {
	case *relayv1.TunnelFrame_Data:
		return s.Write(payload.Data.GetData())
	case *relayv1.TunnelFrame_HalfClose:
		return s.CloseWrite()
	case *relayv1.TunnelFrame_Close:
		// The bridges send Close after both directions ended: wait for the
		// CLOSE exchange. A Close after a failure is a reset.
		s.mu.Lock()
		clean := s.core.finQueued && s.core.finDelivered
		s.mu.Unlock()
		if !clean {
			s.Abort(RstAborted, "local side ended the stream")
			return nil
		}
		s.WaitFinished()
		return nil
	case *relayv1.TunnelFrame_Error:
		s.Abort(RstAborted, payload.Error.GetCode())
		return nil
	}
	return fmt.Errorf("%w: unexpected frame from the bridge", ErrProtocol)
}

// Write queues p for the peer, waiting while the window is full.
func (s *Session) Write(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for !s.core.CanWrite(len(p)) {
		s.writers++
		s.writeCond.Wait()
		s.writers--
	}
	ok, err := s.core.Write(p, time.Now())
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("relayresume: window refused a write")
	}
	s.afterLocked(false)
	return nil
}

// CloseWrite sends FIN after the queued data.
func (s *Session) CloseWrite() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.core.CloseWrite(time.Now())
	s.afterLocked(false)
	return err
}

// Recv hands the bridge the next Data frame, HalfClose for the peer's FIN,
// Close once the stream finished, or the error that reset it. While nothing
// is queued it reads the current path itself. A returned Data frame is valid
// until the next Recv.
func (s *Session) Recv() (*relayv1.TunnelFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inRecv = true
	frame, gone, err := s.recvLocked()
	s.recvExitLocked(gone)
	return frame, err
}

func (s *Session) recvLocked() (*relayv1.TunnelFrame, bool, error) {
	for {
		if len(s.partial) > 0 {
			return s.dataFrame(), false, nil
		}
		data, fin, ok := s.core.Read(time.Now())
		if ok {
			// An ACK leaves on its own goroutine: the bridge goes back to
			// writing the local socket.
			s.afterLocked(true)
			if fin {
				return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}, true, nil
			}
			s.partial = data
			continue
		}
		switch s.core.State() {
		case StateReset:
			return nil, true, s.core.Err()
		case StateFinished:
			return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, true, nil
		}
		if run := s.paths[s.core.Current()]; run != nil && !run.readerBusy && !run.path.Closed() {
			run.readerBusy = true
			s.mu.Unlock()
			frame, err := run.op.Stream.Recv()
			s.mu.Lock()
			run.readerBusy = false
			s.handleFrameLocked(run, frame, err)
			continue
		}
		s.readers++
		s.readCond.Wait()
		s.readers--
	}
}

func (s *Session) dataFrame() *relayv1.TunnelFrame {
	data := s.partial
	if len(data) > s.recvMax {
		data = data[:s.recvMax]
	}
	s.partial = s.partial[len(data):]
	// One frame object per session, refilled on every Recv: a bridge uses
	// a frame before it receives the next one.
	if s.recvData == nil {
		s.recvData = &relayv1.TunnelData{}
		s.recvFrame = &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: s.recvData}}
	}
	s.recvData.Data = data
	return s.recvFrame
}

// WaitFinished blocks until the stream finished or was reset (the CLOSE
// exchange; bounded by the session's own timers).
func (s *Session) WaitFinished() {
	<-s.done
}

// Abort resets the stream: the peer closes its socket hard.
func (s *Session) Abort(code byte, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.core.Abort(code, reason, nil)
	s.afterLocked(false)
}

// abortWith resets the stream with a cause.
func (s *Session) abortWith(code byte, reason string, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.core.Abort(code, reason, cause)
	s.afterLocked(false)
}

// Cancel is the cancel func the bridges call when they end: a no-op for a
// finished stream, a reset otherwise.
func (s *Session) Cancel() { s.Abort(RstAborted, "local side ended the stream") }

// Done closes when the stream finished or was reset.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err is why the stream was reset (nil while open or after a clean finish).
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.Err()
}

// State is the session state.
func (s *Session) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.State()
}

// RelayID is the relay of the current path ("" while suspended).
func (s *Session) RelayID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.core.Current(); p != nil {
		return p.RelayID()
	}
	return ""
}

// CurrentPath is the relay and generation label (OpenedPath.Generation) of
// the path the stream runs on; ok=false while it has none.
func (s *Session) CurrentPath() (relayID string, generation uint64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.core.Current()
	if current == nil {
		return "", 0, false
	}
	if run := s.runOf(current); run != nil {
		generation = run.op.Generation
	}
	return current.RelayID(), generation, true
}

// LastMove is when the stream last moved to another path (zero: never; only
// source streams move).
func (s *Session) LastMove() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil {
		return time.Time{}
	}
	return s.source.movedAt
}

// Moving reports a source stream with a move running (or suspended, waiting
// for a path).
func (s *Session) Moving() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.source != nil && (s.source.migrating || s.core.Current() == nil)
}

// runOf is the driver state of path (mu held).
func (s *Session) runOf(path *Path) *pathRun {
	return s.paths[path]
}

// RouteID is the route the stream belongs to.
func (s *Session) RouteID() string { return s.routeID }

// MaxFrame is the Data size the bridges should be given (their read size
// for bridgeRelayConnection-style bridges, their frame limit always).
func (s *Session) MaxFrame() int { return s.recvMax }

// Unacked is the retained send data.
func (s *Session) Unacked() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.Unacked()
}

// pathDone returns a channel closed once path's stream ended (target).
func (s *Session) pathDone(path *Path) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run := s.paths[path]; run != nil {
		return run.done
	}
	closed := make(chan struct{})
	close(closed)
	return closed
}

// ReadChunk is the read size for a bridge over a session: a DATA frame
// (header and payload) then fits chunk bytes, so the common 32 KiB read stays
// in the allocator's small size classes on both ends.
func ReadChunk(chunk int) int {
	if chunk <= 4*MaxRecordHeader {
		return chunk
	}
	return chunk - MaxRecordHeader
}
