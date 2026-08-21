package docker

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type testRelayFrameStream struct {
	sent     chan *relayv1.TunnelFrame
	received chan *relayv1.TunnelFrame
}

func (s *testRelayFrameStream) Send(frame *relayv1.TunnelFrame) error {
	s.sent <- frame
	return nil
}

func (s *testRelayFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	frame, ok := <-s.received
	if !ok {
		return nil, io.EOF
	}
	return frame, nil
}

func TestBridgeRelayConnectionPreservesResponseAfterLocalHalfClose(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	stream := &testRelayFrameStream{sent: make(chan *relayv1.TunnelFrame, 8), received: make(chan *relayv1.TunnelFrame, 2)}
	bridgeDone := make(chan error, 1)
	go func() {
		bridgeDone <- bridgeRelayConnection(server, stream, 1024, func() {})
	}()

	if _, err := client.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	var request bytes.Buffer
	for {
		select {
		case frame := <-stream.sent:
			if frame.GetData() != nil {
				request.Write(frame.GetData().Data)
			}
			if frame.GetHalfClose() != nil {
				goto requestComplete
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for local half-close")
		}
	}

requestComplete:
	if request.String() != "request" {
		t.Fatalf("forwarded request = %q", request.String())
	}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("response")}}}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	response, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if string(response) != "response" {
		t.Fatalf("response = %q", response)
	}
	select {
	case err := <-bridgeDone:
		if err != nil {
			t.Fatalf("bridge error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge did not finish after both half-closes")
	}
	select {
	case frame := <-stream.sent:
		if frame.GetClose() == nil {
			t.Fatalf("last frame = %T, want close", frame.Payload)
		}
	default:
		t.Fatal("bridge did not send final close")
	}
}

func TestOrderRelayCandidatesBalancesEqualLoadAndPrefersLeastActive(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{{RelayInstanceId: "relay-a"}, {RelayInstanceId: "relay-b"}}
	firstRouter := &relayTunnelRouter{targetID: "relay-a"}
	secondRouter := &relayTunnelRouter{targetID: "relay-b"}
	plugin := &DockerPlugin{relayTunnels: map[string]*relayTunnelRouter{
		"relay-a": firstRouter,
		"relay-b": secondRouter,
	}}

	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-a" {
		t.Fatalf("first candidate = %q, want relay-a", got)
	}
	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-b" {
		t.Fatalf("round-robin candidate = %q, want relay-b", got)
	}
	firstRouter.active.Store(2)
	if got := plugin.orderRelayCandidates(candidates)[0].GetRelayInstanceId(); got != "relay-b" {
		t.Fatalf("least-active candidate = %q, want relay-b", got)
	}
}
