package netaccept

import (
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type flakyListener struct {
	net.Listener
	failures atomic.Int32
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.failures.Add(-1) >= 0 {
		return nil, &net.OpError{Op: "accept", Net: "tcp", Err: syscall.EMFILE}
	}
	return l.Listener.Accept()
}

func TestServeSurvivesTransientErrorsAndEndsWhenClosed(t *testing.T) {
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener := &flakyListener{Listener: inner}
	listener.failures.Store(6)
	handled := make(chan struct{}, 1)
	ended := make(chan struct{})
	go func() {
		Serve(listener, nil, func(connection net.Conn) {
			handled <- struct{}{}
			_ = connection.Close()
		})
		close(ended)
	}()
	connection, err := net.Dial("tcp", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-handled:
	case <-time.After(3 * time.Second):
		t.Fatal("the loop ended on a transient accept error")
	}
	_ = inner.Close()
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("the loop did not end with its listener")
	}
}
