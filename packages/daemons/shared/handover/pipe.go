package handover

import (
	"errors"
	"io"
	"net"
	"sync"
)

// PipeConfig configures a pipe between two local connections.
type PipeConfig struct {
	Labels Labels
	// EndWithRight ends the pipe when its right connection ends: once that
	// end of stream was passed on, both connections close (the secure-link
	// connector's sessions: a target that finished its answer ends the
	// session). Without it a half-close is passed on and the other direction
	// carries on.
	EndWithRight bool
	// Started, if set, is called once the pipe is registered: a handover
	// from then on stops it and passes it on.
	Started func()
	// SnapshotLabels, if set, adds labels a handover takes once the pipe
	// stopped (state a connection wrapper keeps, which the next process
	// restores it with).
	SnapshotLabels func() Labels
}

// Pipe is a node-local link connection the daemon carries between two local
// sockets without a relay (a container link whose target is on this node).
type Pipe struct {
	conns [2]net.Conn
	cfg   PipeConfig
	stop  *stopper
	// pending holds, per direction, what was read and not written yet; only
	// its own direction touches it until it parked.
	pending [2][]byte
	// excluded: why the last handover left it out ("" before any).
	excluded string
}

const (
	// pipeChunk is a direction's read buffer while it moves little: what an
	// idle connection holds.
	pipeChunk = 32 * 1024
	// pipeBulkChunk is its read buffer while reads fill the small one: a
	// node-local link moved a bulk transfer in 32 KiB reads, two syscalls and
	// a copy each, at a third of a direct connection.
	pipeBulkChunk = 256 * 1024
)

var pipeBulkBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, pipeBulkChunk)
	return &buffer
}}

// Pipe copies both ways between left and right until both directions ended,
// passing a half-close on, like the daemons' local pipes: a direction that
// fails closes both. While the daemon hands over to its next process it stops
// (Registry.HandOver) and, handed over, returns ErrHandedOver without touching
// either connection.
func (r *Registry) Pipe(left, right net.Conn, cfg PipeConfig) error {
	return r.pipe(left, right, cfg, [2][]byte{}, [2]bool{})
}

func (r *Registry) pipe(left, right net.Conn, cfg PipeConfig, pending [2][]byte, done [2]bool) error {
	p := &Pipe{conns: [2]net.Conn{left, right}, cfg: cfg, stop: newStopper(0, left, right), pending: pending}
	if r != nil {
		defer r.add(p)()
	}
	if cfg.Started != nil {
		cfg.Started()
	}
	results := make(chan bool, 2)
	running := 0
	for d := range done {
		if done[d] {
			p.stop.finish(side(d))
			continue
		}
		running++
		go func(d side) { results <- p.copy(d) }(side(d))
	}
	handed := false
	for ; running > 0; running-- {
		if <-results {
			handed = true
		}
	}
	if handed {
		return ErrHandedOver
	}
	return nil
}

// copy carries direction d (sideLocal: left to right, sideRemote: right to
// left) and reports whether it was handed over.
func (p *Pipe) copy(d side) bool {
	source, destination := p.conns[0], p.conns[1]
	if d == sideRemote {
		source, destination = destination, source
	}
	small := make([]byte, pipeChunk)
	// bulk is the pooled large buffer while reads fill the small one;
	// pending aliases the buffer it was read into until it is written, so a
	// direction lets go of bulk only with nothing pending.
	var bulk *[]byte
	shrink := false
	defer func() {
		if bulk != nil {
			pipeBulkBuffers.Put(bulk)
		}
	}()
	fail := func() bool {
		p.stop.terminate()
		_ = destination.Close()
		_ = source.Close()
		p.stop.finish(d)
		return false
	}
	// Between two plain sockets the bytes move in the kernel (splice_linux.go); the buffers below then only carry
	// what a stop left pending.
	spliced := newSplicer(source, destination)
	defer spliced.close()
	for {
		for len(p.pending[d]) > 0 {
			n, err := destination.Write(p.pending[d])
			p.pending[d] = p.pending[d][n:]
			if err == nil {
				continue
			}
			park, retry := p.stop.stopped(err)
			switch {
			case retry:
				continue
			case !park:
				return fail()
			}
			if p.stop.park(d) == verdictHanded {
				return true
			}
		}
		if shrink {
			pipeBulkBuffers.Put(bulk)
			bulk, shrink = nil, false
		}
		var n int
		var err error
		if spliced != nil {
			err = spliced.run(&p.pending[d])
			if len(p.pending[d]) > 0 {
				// The destination stopped with bytes in the splicer's pipe: they are pending now, and a stop parks
				// at writing them.
				if park, retry := p.stop.stopped(err); park || retry {
					continue
				}
				return fail()
			}
		} else {
			buffer := small
			if bulk != nil {
				buffer = *bulk
			}
			n, err = source.Read(buffer)
			if n > 0 {
				p.pending[d] = buffer[:n]
				switch {
				case bulk == nil && n == len(buffer):
					bulk = pipeBulkBuffers.Get().(*[]byte)
				case bulk != nil && n < len(buffer)/4:
					shrink = true
				}
				continue
			}
		}
		if err == nil {
			continue
		}
		if park, retry := p.stop.stopped(err); park {
			if p.stop.park(d) == verdictHanded {
				return true
			}
			continue
		} else if retry {
			continue
		}
		if !errors.Is(err, io.EOF) {
			return fail()
		}
		if closer, ok := destination.(interface{ CloseWrite() error }); ok {
			_ = closer.CloseWrite()
		} else {
			return fail()
		}
		if d == sideRemote && p.cfg.EndWithRight {
			return fail()
		}
		p.stop.finish(d)
		return false
	}
}

// quiescent reports a frozen pipe whose directions each parked or ended.
func (p *Pipe) quiescent() (quiet, ok bool) {
	still, terminated := p.stop.directions()
	return still[0] && still[1], !terminated
}

// pinned: a pipe without both sockets stays with this process.
func (p *Pipe) pinned() bool {
	_, leftErr := socketOf(p.conns[0])
	_, rightErr := socketOf(p.conns[1])
	return leftErr != nil || rightErr != nil
}

func (p *Pipe) freeze() { p.stop.freeze() }

func (p *Pipe) thaw() { p.stop.release(verdictThaw) }

func (p *Pipe) handedOver() {
	markHandedOver(p.conns[0])
	markHandedOver(p.conns[1])
	p.stop.release(verdictHanded)
}

var _ item = (*Pipe)(nil)
