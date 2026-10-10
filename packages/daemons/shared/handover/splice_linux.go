//go:build linux

package handover

import (
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// spliceChunk bounds one splice(2).
	spliceChunk = 1 << 20
	// splicePipeSize sizes the pipes: 64 pages, a quarter of what the rc.11
	// pipes asked for. The user's pipe budget is shared by every process of
	// the uid on the host (and, in unprivileged containers sharing an id
	// map, by all of them): with 1 MiB pipes a few busy connectors spent it,
	// and the next pipes were refused (stand rc.11 F-2: 9 of 20 same-node
	// transfers copied through the buffers at 1.6-2.6 CPU-s/GiB).
	splicePipeSize = 256 << 10
	// spliceMinPipe is the smallest pipe worth splicing through. Linux
	// accounts pipe buffers per user: once a user holds more than
	// fs.pipe-user-pages-soft (64 MiB by default, every process of that uid
	// on the host together, containers included), new pipes get two pages
	// and cannot be resized. A splice through 8 KiB moves a few KiB per
	// system call and wakeup (stand rc.10 F-2: the connector, uid 65532 like
	// every distroless container, at 3-4 CPU-s/GiB, 90 % in the kernel, and
	// half rc.8's same-node speed); a copy through a 256 KiB buffer is
	// cheaper than that.
	spliceMinPipe = 256 << 10
	// splicePipesMax bounds the pipes this process holds, in use or idle
	// (each splicePipeSize of the user's pipe budget); a direction that
	// finds none copies through its buffers until one is free.
	splicePipesMax = 32
	// splicePipesIdle is how many emptied pipes are kept for the next bulk
	// read instead of being closed.
	splicePipesIdle = 4
	// spliceRetry is how long after the system refused a full-size pipe no
	// new one is asked for: one refused pipe costs a few system calls, and
	// the budget comes back as soon as another process closes its pipes.
	spliceRetry = time.Second
)

// splicePipeBytes and splicePipeMin are splicePipeSize and spliceMinPipe
// (variables for the benchmarks of other pipe sizes).
var splicePipeBytes, splicePipeMin = splicePipeSize, spliceMinPipe

// errNoPipe: no pipe is free for this read; the direction copies through its
// buffers this time.
var errNoPipe = errors.New("handover: no splice pipe free")

// splicePipe is one kernel pipe the splicers share, one at a time.
type splicePipe struct{ r, w int }

// splicePipes holds the pipes of this process: a direction takes one only
// while bytes flow (an idle connection waits without one), so the pipes in
// use are those of the transfers running now, not one per connection
// direction (the rc.10 splicer held two per session for its life, which put
// the connector over the user's pipe budget).
var splicePipes struct {
	sync.Mutex
	free    []*splicePipe
	open    int
	refused time.Time
}

// takePipe returns a free full-size pipe, or nil when none is free or the
// system gives only small ones.
func takePipe() *splicePipe {
	splicePipes.Lock()
	if n := len(splicePipes.free); n > 0 {
		pipe := splicePipes.free[n-1]
		splicePipes.free = splicePipes.free[:n-1]
		splicePipes.Unlock()
		return pipe
	}
	if splicePipes.open >= splicePipesMax || (!splicePipes.refused.IsZero() && time.Since(splicePipes.refused) < spliceRetry) {
		splicePipes.Unlock()
		return nil
	}
	splicePipes.open++
	splicePipes.Unlock()
	pipe, ok := openPipe()
	if !ok {
		splicePipes.Lock()
		splicePipes.open--
		splicePipes.refused = time.Now()
		splicePipes.Unlock()
		return nil
	}
	return pipe
}

// openPipe opens a pipe of splicePipeBytes; false when the system has no
// pipe or gives less than splicePipeMin.
func openPipe() (*splicePipe, bool) {
	var fds [2]int
	if err := unix.Pipe2(fds[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		return nil, false
	}
	_, _ = unix.FcntlInt(uintptr(fds[1]), unix.F_SETPIPE_SZ, splicePipeBytes)
	size, err := unix.FcntlInt(uintptr(fds[1]), unix.F_GETPIPE_SZ, 0)
	if err != nil || size < splicePipeMin {
		_ = unix.Close(fds[0])
		_ = unix.Close(fds[1])
		return nil, false
	}
	return &splicePipe{r: fds[0], w: fds[1]}, true
}

// releasePipe gives back an empty pipe.
func releasePipe(pipe *splicePipe) {
	splicePipes.Lock()
	if len(splicePipes.free) < splicePipesIdle {
		splicePipes.free = append(splicePipes.free, pipe)
		splicePipes.Unlock()
		return
	}
	splicePipes.open--
	splicePipes.Unlock()
	pipe.close()
}

// dropPipe closes a pipe that may still hold bytes: it never serves another
// connection.
func dropPipe(pipe *splicePipe) {
	splicePipes.Lock()
	splicePipes.open--
	splicePipes.Unlock()
	pipe.close()
}

func (p *splicePipe) close() {
	_ = unix.Close(p.r)
	_ = unix.Close(p.w)
}

// splicer moves one direction of a pipe between two sockets in the kernel:
// splice(2) from the source into a pipe, and from there into the
// destination, as io.Copy between two TCP sockets does, so the bytes never
// pass through this process. Unlike io.Copy it gives back what the pipe holds
// when the destination stops (a freeze's deadline): those bytes become the
// direction's pending bytes, which a handover passes on, so no byte is lost
// between the two sockets.
type splicer struct {
	src, dst syscall.RawConn
	// pipe is held while bytes flow (nil while the source has nothing);
	// inPipe counts its bytes.
	pipe   *splicePipe
	inPipe int
}

// newSplicer returns a splicer from source to destination, or nil when
// either is not a plain stream socket (a wrapper that counts or transforms
// bytes is copied as before) or splicing does not pay for the pair.
func newSplicer(source, destination net.Conn) *splicer {
	src, srcUnix := spliceable(source)
	dst, dstUnix := spliceable(destination)
	if src == nil || dst == nil || !spliceWorth(srcUnix, dstUnix) {
		return nil
	}
	return &splicer{src: src, dst: dst}
}

// spliceWorth reports whether splicing beats a copy through a 256 KiB buffer
// from a source to a destination socket of these kinds (true: Unix stream
// socket). Measured on the stand (rc.10 F-2, app-node-1, BenchmarkPipeCost):
// through a full-size pipe it does for every pair, Unix sockets included
// (0.43-0.62 CPU-s per GiB against 0.70-0.83 for the buffers and 0.45-0.72
// for io.Copy); through the two-page pipe of a spent budget it does not
// (1.04-1.92), which takePipe refuses.
var spliceWorth = func(srcUnix, dstUnix bool) bool { return true }

// spliceable is the raw socket of a plain TCP or Unix stream connection, or of
// a restored one (which holds no byte of its own), and whether it is a Unix
// socket.
func spliceable(connection net.Conn) (syscall.RawConn, bool) {
	for depth := 0; depth < 4; depth++ {
		var conn syscall.Conn
		isUnix := false
		switch current := connection.(type) {
		case *net.TCPConn:
			conn = current
		case *net.UnixConn:
			conn, isUnix = current, true
		case *restoredConn:
			connection = current.Conn
			continue
		default:
			return nil, false
		}
		raw, err := conn.SyscallConn()
		if err != nil {
			return nil, false
		}
		stream := false
		if err := raw.Control(func(fd uintptr) {
			kind, err := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TYPE)
			stream = err == nil && kind == unix.SOCK_STREAM
		}); err != nil || !stream {
			return nil, false
		}
		return raw, isUnix
	}
	return nil, false
}

// run moves bytes until the source ends (io.EOF) or a read or write fails,
// a freeze's deadline among them. What the pipe held then is appended to
// *pending: the caller writes it before anything else. errNoPipe: no pipe was
// free for the next read (nothing was read); the caller reads it through its
// buffers.
func (s *splicer) run(pending *[]byte) error {
	for {
		if s.inPipe == 0 {
			var n int64
			var spliceErr error
			noPipe := false
			err := s.src.Read(func(fd uintptr) bool {
				if s.pipe == nil {
					if s.pipe = takePipe(); s.pipe == nil {
						noPipe = true
						return true
					}
				}
				for {
					n, spliceErr = unix.Splice(int(fd), nil, s.pipe.w, nil, spliceChunk, unix.SPLICE_F_MOVE|unix.SPLICE_F_NONBLOCK)
					if spliceErr != unix.EINTR {
						break
					}
				}
				if spliceErr == unix.EAGAIN {
					// The source has nothing now: wait for it without a pipe.
					releasePipe(s.pipe)
					s.pipe = nil
					return false
				}
				return true
			})
			if noPipe {
				return errNoPipe
			}
			if err == nil && spliceErr != nil {
				err = os.NewSyscallError("splice", spliceErr)
			}
			if err == nil && n == 0 {
				err = io.EOF
			}
			if err != nil {
				s.release()
				return err
			}
			s.inPipe = int(n)
		}
		var spliceErr error
		err := s.dst.Write(func(fd uintptr) bool {
			for s.inPipe > 0 {
				n, err := unix.Splice(s.pipe.r, nil, int(fd), nil, s.inPipe, unix.SPLICE_F_MOVE|unix.SPLICE_F_NONBLOCK)
				switch {
				case err == unix.EINTR:
					continue
				case err == unix.EAGAIN:
					return false
				case err != nil:
					spliceErr = os.NewSyscallError("splice", err)
					return true
				}
				s.inPipe -= int(n)
			}
			return true
		})
		if err == nil {
			err = spliceErr
		}
		if err != nil {
			s.giveBack(pending)
			return err
		}
	}
}

// giveBack reads what the pipe holds into *pending and lets go of the pipe.
func (s *splicer) giveBack(pending *[]byte) {
	if s.inPipe > 0 {
		buffer := make([]byte, s.inPipe)
		read := 0
		for read < len(buffer) {
			n, err := unix.Read(s.pipe.r, buffer[read:])
			if n > 0 {
				read += n
			}
			if err == unix.EINTR {
				continue
			}
			if err != nil || n <= 0 {
				break
			}
		}
		*pending = append(*pending, buffer[:read]...)
		s.inPipe -= read
	}
	s.release()
}

// release lets go of the pipe: back to the others when empty, else closed.
func (s *splicer) release() {
	if s.pipe == nil {
		return
	}
	if s.inPipe == 0 {
		releasePipe(s.pipe)
	} else {
		dropPipe(s.pipe)
	}
	s.pipe, s.inPipe = nil, 0
}

func (s *splicer) close() {
	if s == nil {
		return
	}
	s.release()
}
