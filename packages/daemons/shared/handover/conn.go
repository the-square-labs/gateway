package handover

import (
	"errors"
	"net"
	"os"
	"sync/atomic"
	"syscall"
)

// Wrapper is a connection wrapper the daemon puts around a local socket
// (traffic counters, drain bookkeeping) that holds no byte of the stream
// itself: a handover passes the socket inside on. A wrapper with bytes of its
// own (TLS) must not implement it: its connection is cut as before.
type Wrapper interface {
	HandoverInner() net.Conn
}

// HandedOverMarker is a wrapper that may end its connection itself (a drain
// that shuts it down): once the next process carries the connection, it must
// not any more.
type HandedOverMarker interface {
	MarkHandedOver()
}

// errNoSocket reports a connection whose socket cannot be handed over: a
// wrapper that keeps bytes of its own (TLS) or no socket at all.
var errNoSocket = errors.New("handover: the connection has no socket to hand over")

// socketOf returns the socket under connection's wrappers.
func socketOf(connection net.Conn) (net.Conn, error) {
	for depth := 0; connection != nil && depth < 16; depth++ {
		switch current := connection.(type) {
		case *net.TCPConn, *net.UnixConn:
			return current, nil
		case *restoredConn:
			connection = current.Conn
		case Wrapper:
			connection = current.HandoverInner()
		default:
			return nil, errNoSocket
		}
	}
	return nil, errNoSocket
}

// markHandedOver tells the restored sockets under connection that another
// process carries them now: closing this process's copy must not end them.
func markHandedOver(connection net.Conn) {
	for depth := 0; connection != nil && depth < 16; depth++ {
		if marker, ok := connection.(HandedOverMarker); ok {
			marker.MarkHandedOver()
		}
		switch current := connection.(type) {
		case *restoredConn:
			current.handedOver.Store(true)
			connection = current.Conn
		case Wrapper:
			connection = current.HandoverInner()
		default:
			return
		}
	}
}

// duplicate returns a copy of the socket's descriptor (close-on-exec) and its
// inode, which names that very socket for the next process. It never calls
// File: that switches the descriptor every copy shares to blocking mode.
func duplicate(socket net.Conn) (*os.File, uint64, error) {
	conn, ok := socket.(syscall.Conn)
	if !ok {
		return nil, 0, errNoSocket
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil, 0, err
	}
	duplicated := -1
	var inode uint64
	var dupErr error
	syscall.ForkLock.RLock()
	controlErr := raw.Control(func(fd uintptr) {
		var stat syscall.Stat_t
		if dupErr = syscall.Fstat(int(fd), &stat); dupErr != nil {
			return
		}
		inode = uint64(stat.Ino)
		if duplicated, dupErr = syscall.Dup(int(fd)); dupErr == nil {
			syscall.CloseOnExec(duplicated)
		}
	})
	syscall.ForkLock.RUnlock()
	if controlErr != nil {
		return nil, 0, controlErr
	}
	if dupErr != nil {
		return nil, 0, dupErr
	}
	return os.NewFile(uintptr(duplicated), "handover-conn"), inode, nil
}

// inodeOf is the inode of a descriptor the previous process handed over.
func inodeOf(file *os.File) (uint64, error) {
	var stat syscall.Stat_t
	raw, err := file.SyscallConn()
	if err != nil {
		return 0, err
	}
	var statErr error
	if err := raw.Control(func(fd uintptr) { statErr = syscall.Fstat(int(fd), &stat) }); err != nil {
		return 0, err
	}
	if statErr != nil {
		return 0, statErr
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		return 0, errNoSocket
	}
	return uint64(stat.Ino), nil
}

// restoredConn is a socket the previous process handed over. The keeper's copy
// is dropped right after the take, but a copy that outlived the drop would
// keep the connection open after close: ending it shuts it down first, so the
// peer sees the end whatever holds a copy. Once handed over again, closing is
// only this process letting go.
type restoredConn struct {
	net.Conn
	handedOver atomic.Bool
}

func (c *restoredConn) Close() error {
	if !c.handedOver.Load() {
		shutdown(c.Conn)
	}
	return c.Conn.Close()
}

// CloseWrite passes a half-close on to the socket.
func (c *restoredConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// CloseRead passes a read shutdown on to the socket.
func (c *restoredConn) CloseRead() error {
	if closer, ok := c.Conn.(interface{ CloseRead() error }); ok {
		return closer.CloseRead()
	}
	return nil
}

// shutdown ends a connection for its peer, whatever else holds a copy of it.
func shutdown(connection net.Conn) {
	if half, ok := connection.(interface {
		CloseRead() error
		CloseWrite() error
	}); ok {
		_ = half.CloseWrite()
		_ = half.CloseRead()
	}
}
