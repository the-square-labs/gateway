package relaybridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const MaxChunkBytes = 1024 * 1024

type FrameStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

type result struct {
	local    bool
	terminal bool
	err      error
}

// Bridge copies opaque TCP bytes between a local connection and a relay
// stream. It deliberately has no idle deadline: lifecycle is controlled by
// TCP close, half-close, relay revocation, or the supplied context.
func Bridge(ctx context.Context, connection net.Conn, stream FrameStream, maxFrame int, cancel context.CancelFunc) error {
	if maxFrame <= 0 || maxFrame > MaxChunkBytes {
		maxFrame = MaxChunkBytes
	}
	completed := make(chan result, 2)
	go sendLocal(connection, stream, maxFrame, completed)
	go receiveRemote(connection, stream, maxFrame, completed)

	var localDone, remoteDone, terminated bool
	var bridgeErr error
	for !localDone || !remoteDone {
		select {
		case <-ctx.Done():
			if !terminated {
				terminated = true
				cancel()
				_ = connection.Close()
			}
		case item := <-completed:
			if item.local {
				localDone = true
			} else {
				remoteDone = true
			}
			if item.err != nil && bridgeErr == nil {
				bridgeErr = item.err
			}
			if (item.terminal || item.err != nil) && !terminated {
				terminated = true
				cancel()
				_ = connection.Close()
			}
		}
	}
	if !terminated {
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
		cancel()
		_ = connection.Close()
	}
	return bridgeErr
}

func sendLocal(connection net.Conn, stream FrameStream, maxFrame int, completed chan<- result) {
	buffer := make([]byte, maxFrame)
	for {
		n, err := connection.Read(buffer)
		if n > 0 {
			frame := append([]byte(nil), buffer[:n]...)
			if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: frame}}}); sendErr != nil {
				completed <- result{local: true, terminal: true, err: sendErr}
				return
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}); sendErr != nil {
					completed <- result{local: true, terminal: true, err: sendErr}
					return
				}
				completed <- result{local: true}
				return
			}
			completed <- result{local: true, terminal: true, err: err}
			return
		}
	}
}

func receiveRemote(connection net.Conn, stream FrameStream, maxFrame int, completed chan<- result) {
	for {
		frame, err := stream.Recv()
		if err != nil {
			completed <- result{terminal: true, err: err}
			return
		}
		switch {
		case frame.GetData() != nil:
			data := frame.GetData().Data
			if len(data) == 0 || len(data) > maxFrame {
				completed <- result{terminal: true, err: errors.New("invalid relay frame size")}
				return
			}
			for len(data) > 0 {
				n, writeErr := connection.Write(data)
				if writeErr != nil {
					completed <- result{terminal: true, err: writeErr}
					return
				}
				data = data[n:]
			}
		case frame.GetHalfClose() != nil:
			if tcp, ok := connection.(*net.TCPConn); ok {
				_ = tcp.CloseWrite()
			}
			completed <- result{}
			return
		case frame.GetClose() != nil:
			completed <- result{terminal: true}
			return
		case frame.GetError() != nil:
			completed <- result{terminal: true, err: fmt.Errorf("relay tunnel error: %s", frame.GetError().Code)}
			return
		default:
			completed <- result{terminal: true, err: errors.New("unexpected relay tunnel frame")}
			return
		}
	}
}
