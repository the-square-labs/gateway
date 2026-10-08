package handover

import (
	"errors"
	"io"
	"net"
)

// PipeConfig configures a pipe between two local connections.
type PipeConfig struct {
	Labels Labels
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

const pipeChunk = 32 * 1024

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
	buffer := make([]byte, pipeChunk)
	fail := func() bool {
		p.stop.terminate()
		_ = destination.Close()
		_ = source.Close()
		p.stop.finish(d)
		return false
	}
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
		n, err := source.Read(buffer)
		if n > 0 {
			p.pending[d] = append(p.pending[d][:0], buffer[:n]...)
			continue
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
