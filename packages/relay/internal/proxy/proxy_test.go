package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/relay/internal/codec"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type transportStream struct {
	method  string
	header  metadata.MD
	trailer metadata.MD
}

func (s *transportStream) Method() string { return s.method }
func (s *transportStream) SetHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *transportStream) SendHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *transportStream) SetTrailer(md metadata.MD) error {
	s.trailer = metadata.Join(s.trailer, md)
	return nil
}

type downstreamStream struct {
	ctx      context.Context
	input    []codec.Frame
	position int
	output   []codec.Frame
	header   metadata.MD
	trailer  metadata.MD
}

func (s *downstreamStream) SetHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *downstreamStream) SendHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *downstreamStream) SetTrailer(md metadata.MD) { s.trailer = metadata.Join(s.trailer, md) }
func (s *downstreamStream) Context() context.Context  { return s.ctx }
func (s *downstreamStream) SendMsg(value any) error {
	frame := value.(*codec.Frame)
	s.output = append(s.output, append(codec.Frame(nil), (*frame)...))
	return nil
}
func (s *downstreamStream) RecvMsg(value any) error {
	if s.position >= len(s.input) {
		return io.EOF
	}
	frame := value.(*codec.Frame)
	*frame = append((*frame)[:0], s.input[s.position]...)
	s.position++
	return nil
}

func TestTransparentProxyStreamingContracts(t *testing.T) {
	var metadataMu sync.Mutex
	seenMetadata := map[string]metadata.MD{}
	conn, stop := startUpstream(t, func(_ any, stream grpc.ServerStream) error {
		method, _ := grpc.MethodFromServerStream(stream)
		incoming, _ := metadata.FromIncomingContext(stream.Context())
		metadataMu.Lock()
		seenMetadata[method] = incoming.Copy()
		metadataMu.Unlock()
		_ = stream.SendHeader(metadata.Pairs("x-upstream-header", "present"))
		stream.SetTrailer(metadata.Pairs("x-upstream-trailer", "present"))

		var frames []codec.Frame
		for {
			var frame codec.Frame
			err := stream.RecvMsg(&frame)
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			frames = append(frames, append(codec.Frame(nil), frame...))
			if method == "/gateway.v1.Contract/Bidi" {
				if err := stream.SendMsg(&frame); err != nil {
					return err
				}
			}
		}
		switch method {
		case "/gateway.v1.Contract/Unary":
			return stream.SendMsg(&frames[0])
		case "/gateway.v1.Contract/ClientStream":
			combined := codec.Frame{}
			for _, frame := range frames {
				combined = append(combined, frame...)
			}
			return stream.SendMsg(&combined)
		case "/gateway.v1.Contract/ServerStream":
			for index := byte(1); index <= 3; index++ {
				frame := codec.Frame{frames[0][0], index}
				if err := stream.SendMsg(&frame); err != nil {
					return err
				}
			}
		case "/gateway.v1.Contract/Status":
			return status.Error(codes.InvalidArgument, "contract failure")
		}
		return nil
	})
	defer stop()
	handler := New(conn, func() (*grpc.ClientConn, error) { return conn, nil })

	tests := []struct {
		name   string
		method string
		input  []codec.Frame
		want   []codec.Frame
	}{
		{"unary", "/gateway.v1.Contract/Unary", []codec.Frame{{1}}, []codec.Frame{{1}}},
		{"client streaming", "/gateway.v1.Contract/ClientStream", []codec.Frame{{1}, {2}, {3}}, []codec.Frame{{1, 2, 3}}},
		{"server streaming", "/gateway.v1.Contract/ServerStream", []codec.Frame{{9}}, []codec.Frame{{9, 1}, {9, 2}, {9, 3}}},
		{"bidirectional streaming", "/gateway.v1.Contract/Bidi", []codec.Frame{{4}, {5}, {6}}, []codec.Frame{{4}, {5}, {6}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := authenticatedDownstream(test.method, test.input, context.Background())
			if err := handler.Handle(nil, stream); err != nil {
				t.Fatal(err)
			}
			if !equalFrames(stream.output, test.want) {
				t.Fatalf("output = %v, want %v", stream.output, test.want)
			}
			if stream.header.Get("x-upstream-header")[0] != "present" || stream.trailer.Get("x-upstream-trailer")[0] != "present" {
				t.Fatalf("headers/trailers were not forwarded: header=%v trailer=%v", stream.header, stream.trailer)
			}
		})
	}

	stream := authenticatedDownstream("/gateway.v1.Contract/Status", []codec.Frame{{1}}, context.Background())
	if code := status.Code(handler.Handle(nil, stream)); code != codes.InvalidArgument {
		t.Fatalf("status code = %v", code)
	}
	metadataMu.Lock()
	forwarded := seenMetadata["/gateway.v1.Contract/Unary"]
	metadataMu.Unlock()
	if forwarded.Get("x-wiolett-relay-spoofed") != nil || forwarded.Get("x-wiolett-relay-node-id")[0] != "node-1" || forwarded.Get("x-client-metadata")[0] != "kept" {
		t.Fatalf("metadata was not sanitized and injected: %v", forwarded)
	}
}

func TestTransparentProxyDeadlineAndCancellation(t *testing.T) {
	conn, stop := startUpstream(t, func(_ any, stream grpc.ServerStream) error {
		<-stream.Context().Done()
		return stream.Context().Err()
	})
	defer stop()
	handler := New(conn, func() (*grpc.ClientConn, error) { return conn, nil })

	deadlineCtx, cancelDeadline := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelDeadline()
	if code := status.Code(handler.Handle(nil, authenticatedDownstream("/gateway.v1.Contract/Wait", []codec.Frame{{1}}, deadlineCtx))); code != codes.DeadlineExceeded {
		t.Fatalf("deadline status = %v", code)
	}

	cancelCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if code := status.Code(handler.Handle(nil, authenticatedDownstream("/gateway.v1.Contract/Wait", []codec.Frame{{1}}, cancelCtx))); code != codes.Canceled {
		t.Fatalf("cancellation status = %v", code)
	}
}

func authenticatedDownstream(method string, input []codec.Frame, base context.Context) *downstreamStream {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: "node-1"}, SerialNumber: big.NewInt(42), Raw: []byte("node-certificate")}
	ctx := metadata.NewIncomingContext(base, metadata.Pairs("x-client-metadata", "kept", "x-wiolett-relay-spoofed", "removed"))
	ctx = grpcpeer.NewContext(ctx, &grpcpeer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}})
	transport := &transportStream{method: method}
	ctx = grpc.NewContextWithServerTransportStream(ctx, transport)
	return &downstreamStream{ctx: ctx, input: input}
}

func startUpstream(t *testing.T, handler grpc.StreamHandler) (*grpc.ClientConn, func()) {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer(grpc.ForceServerCodec(codec.Codec{}), grpc.UnknownServiceHandler(handler))
	go func() { _ = server.Serve(listener) }()
	conn, err := grpc.NewClient("passthrough:///upstream", grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }), grpc.WithInsecure(), grpc.WithDefaultCallOptions(grpc.ForceCodec(codec.Codec{})))
	if err != nil {
		t.Fatal(err)
	}
	return conn, func() { _ = conn.Close(); server.Stop(); _ = listener.Close() }
}

func equalFrames(left, right []codec.Frame) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if string(left[index]) != string(right[index]) {
			return false
		}
	}
	return true
}
