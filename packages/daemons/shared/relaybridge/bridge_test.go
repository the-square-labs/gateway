package relaybridge

import (
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type channelFrameStream struct {
	sent     chan *relayv1.TunnelFrame
	received chan *relayv1.TunnelFrame
}

func (s *channelFrameStream) Send(frame *relayv1.TunnelFrame) error {
	s.sent <- frame
	return nil
}

func (s *channelFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	frame, ok := <-s.received
	if !ok {
		return nil, io.EOF
	}
	return frame, nil
}

func TestBridgeCopiesOpaqueBytesAndPreservesHalfClose(t *testing.T) {
	local, peer := tcpPair(t)
	stream := &channelFrameStream{sent: make(chan *relayv1.TunnelFrame, 4), received: make(chan *relayv1.TunnelFrame, 2)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Bridge(ctx, local, stream, 64*1024, cancel) }()

	request := []byte{0x00, 0xff, 'r', 'e', 'q'}
	if _, err := peer.Write(request); err != nil {
		t.Fatal(err)
	}
	if err := peer.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response := []byte{0xfe, 0x00, 'o', 'k'}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: response}}}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}

	actual, err := io.ReadAll(peer)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(response) {
		t.Fatalf("response = %v, want %v", actual, response)
	}

	first := <-stream.sent
	if string(first.GetData().Data) != string(request) {
		t.Fatalf("request frame = %v, want %v", first.GetData().Data, request)
	}
	if (<-stream.sent).GetHalfClose() == nil {
		t.Fatal("expected local half-close frame")
	}
	if (<-stream.sent).GetClose() == nil {
		t.Fatal("expected terminal close frame")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge did not finish after both half-closes")
	}
}

func TestBridgePropagatesRemoteHalfCloseToUnixConnection(t *testing.T) {
	local, peer := unixPair(t)
	stream := &channelFrameStream{sent: make(chan *relayv1.TunnelFrame, 4), received: make(chan *relayv1.TunnelFrame, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Bridge(ctx, local, stream, 64*1024, cancel) }()

	request := []byte("GET / HTTP/1.1\r\nConnection: close\r\n\r\n")
	if _, err := peer.Write(request); err != nil {
		t.Fatal(err)
	}
	if err := peer.CloseWrite(); err != nil {
		t.Fatal(err)
	}

	response := bytes.Repeat([]byte("close-delimited-response-"), 10*1024)
	for len(response) > 0 {
		chunkSize := min(len(response), 32*1024)
		chunk := append([]byte(nil), response[:chunkSize]...)
		stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: chunk}}}
		response = response[chunkSize:]
	}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}

	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	actual, err := io.ReadAll(peer)
	if err != nil {
		t.Fatalf("read close-delimited Unix response: %v", err)
	}
	want := bytes.Repeat([]byte("close-delimited-response-"), 10*1024)
	if !bytes.Equal(actual, want) {
		t.Fatalf("response bytes = %d, want %d", len(actual), len(want))
	}

	first := <-stream.sent
	if !bytes.Equal(first.GetData().Data, request) {
		t.Fatalf("request frame = %q, want %q", first.GetData().Data, request)
	}
	if (<-stream.sent).GetHalfClose() == nil {
		t.Fatal("expected Unix client half-close frame")
	}
	if (<-stream.sent).GetClose() == nil {
		t.Fatal("expected terminal close frame")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge did not finish after Unix half-closes")
	}
}

func tcpPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	peer, err := net.DialTCP("tcp4", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	local, err := listener.AcceptTCP()
	if err != nil {
		peer.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		local.Close()
		peer.Close()
	})
	return local, peer
}

func unixPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "relaybridge-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "bridge.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	peer, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	local, err := listener.AcceptUnix()
	if err != nil {
		peer.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		local.Close()
		peer.Close()
	})
	return local, peer
}
