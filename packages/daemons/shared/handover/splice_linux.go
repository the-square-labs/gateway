//go:build linux

package handover

import (
	"io"
	"net"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// spliceChunk bounds one splice(2) and sizes the splicer's pipe.
const spliceChunk = 1 << 20

// splicer moves one direction of a pipe between two sockets in the kernel:
// splice(2) from the source into a pipe of its own, and from there into the
// destination, as io.Copy between two sockets does, so the bytes never pass
// through this process (a node-local link or a secure-link connector session
// costs a third of the CPU of a read/write copy). Unlike io.Copy it gives
// back what its pipe holds when the destination stops (a freeze's deadline):
// those bytes become the direction's pending bytes, which a handover passes
// on, so no byte is lost between the two sockets.
type splicer struct {
	src, dst syscall.RawConn
	// pr and pw are the pipe's read and write ends; inPipe counts its bytes.
	pr, pw int
	inPipe int
}

// newSplicer returns a splicer from source to destination, or nil when either
// is not a plain stream socket (a wrapper that counts or transforms bytes is
// copied as before) or the system has no pipe for it.
func newSplicer(source, destination net.Conn) *splicer {
	src, dst := spliceable(source), spliceable(destination)
	if src == nil || dst == nil {
		return nil
	}
	var fds [2]int
	if err := unix.Pipe2(fds[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		return nil
	}
	// A larger pipe moves more per splice; the default (64 KiB) where the
	// system refuses it.
	_, _ = unix.FcntlInt(uintptr(fds[1]), unix.F_SETPIPE_SZ, spliceChunk)
	return &splicer{src: src, dst: dst, pr: fds[0], pw: fds[1]}
}

// spliceable is the raw socket of a plain TCP or Unix stream connection, or of
// a restored one (which holds no byte of its own).
func spliceable(connection net.Conn) syscall.RawConn {
	for depth := 0; depth < 4; depth++ {
		var conn syscall.Conn
		switch current := connection.(type) {
		case *net.TCPConn:
			conn = current
		case *net.UnixConn:
			conn = current
		case *restoredConn:
			connection = current.Conn
			continue
		default:
			return nil
		}
		raw, err := conn.SyscallConn()
		if err != nil {
			return nil
		}
		stream := false
		if err := raw.Control(func(fd uintptr) {
			kind, err := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TYPE)
			stream = err == nil && kind == unix.SOCK_STREAM
		}); err != nil || !stream {
			return nil
		}
		return raw
	}
	return nil
}

// run moves bytes until the source ends (io.EOF) or a read or write fails,
// a freeze's deadline among them. What its pipe held then is appended to
// *pending: the caller writes it before anything else.
func (s *splicer) run(pending *[]byte) error {
	for {
		if s.inPipe == 0 {
			var n int64
			var spliceErr error
			err := s.src.Read(func(fd uintptr) bool {
				for {
					n, spliceErr = unix.Splice(int(fd), nil, s.pw, nil, spliceChunk, unix.SPLICE_F_MOVE|unix.SPLICE_F_NONBLOCK)
					if spliceErr != unix.EINTR {
						break
					}
				}
				return spliceErr != unix.EAGAIN
			})
			if err != nil {
				return err
			}
			if spliceErr != nil {
				return os.NewSyscallError("splice", spliceErr)
			}
			if n == 0 {
				return io.EOF
			}
			s.inPipe = int(n)
		}
		var spliceErr error
		err := s.dst.Write(func(fd uintptr) bool {
			for s.inPipe > 0 {
				n, err := unix.Splice(s.pr, nil, int(fd), nil, s.inPipe, unix.SPLICE_F_MOVE|unix.SPLICE_F_NONBLOCK)
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

// giveBack reads what the pipe holds into *pending.
func (s *splicer) giveBack(pending *[]byte) {
	if s.inPipe == 0 {
		return
	}
	buffer := make([]byte, s.inPipe)
	read := 0
	for read < len(buffer) {
		n, err := unix.Read(s.pr, buffer[read:])
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
	s.inPipe = 0
}

func (s *splicer) close() {
	if s == nil {
		return
	}
	_ = unix.Close(s.pr)
	_ = unix.Close(s.pw)
}
