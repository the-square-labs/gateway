package proxy

import (
	"context"
	"io"
	"strings"
	"sync"

	"github.com/wiolett-industries/gateway/relay/internal/codec"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	gatewayPrefix    = "/gateway.v1."
	enrollmentMethod = "/gateway.v1.NodeEnrollment/Enroll"
	metadataPrefix   = "x-wiolett-relay-"
)

type Handler struct {
	mu       sync.RWMutex
	upstream *grpc.ClientConn
	connect  func() (*grpc.ClientConn, error)
}

func New(upstream *grpc.ClientConn, connect func() (*grpc.ClientConn, error)) *Handler {
	return &Handler{upstream: upstream, connect: connect}
}

func (h *Handler) ReloadUpstream() error {
	next, err := h.connect()
	if err != nil {
		return err
	}
	h.mu.Lock()
	previous := h.upstream
	h.upstream = next
	h.mu.Unlock()
	return previous.Close()
}

func (h *Handler) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.upstream.Close()
}

func (h *Handler) Handle(_ any, downstream grpc.ServerStream) error {
	method, ok := grpc.MethodFromServerStream(downstream)
	if !ok || !strings.HasPrefix(method, gatewayPrefix) {
		return status.Error(codes.Unimplemented, "relay method is not registered")
	}
	identity, authenticated := peer.FromContext(downstream.Context())
	if method != enrollmentMethod && !authenticated {
		return status.Error(codes.Unauthenticated, "verified daemon certificate required")
	}
	incoming, _ := metadata.FromIncomingContext(downstream.Context())
	outgoing := sanitizeMetadata(incoming)
	if authenticated {
		outgoing.Set("x-wiolett-relay-node-id", identity.SubjectID)
		outgoing.Set("x-wiolett-relay-cert-serial", identity.CertificateSerial)
		outgoing.Set("x-wiolett-relay-cert-sha256", identity.CertificateFingerprint)
	}
	ctx, cancel := context.WithCancel(metadata.NewOutgoingContext(downstream.Context(), outgoing))
	defer cancel()
	h.mu.RLock()
	connection := h.upstream
	h.mu.RUnlock()
	upstream, err := connection.NewStream(ctx, &grpc.StreamDesc{ServerStreams: true, ClientStreams: true}, method, grpc.ForceCodec(codec.Codec{}))
	if err != nil {
		return err
	}
	clientResult := make(chan error, 1)
	go func() {
		for {
			var frame codec.Frame
			if err := downstream.RecvMsg(&frame); err != nil {
				if err == io.EOF {
					clientResult <- upstream.CloseSend()
					return
				}
				clientResult <- err
				return
			}
			if err := upstream.SendMsg(&frame); err != nil {
				clientResult <- err
				return
			}
		}
	}()
	header, err := upstream.Header()
	if err != nil {
		return err
	}
	if len(header) > 0 {
		if err := downstream.SendHeader(header); err != nil {
			return err
		}
	}
	for {
		var frame codec.Frame
		recvErr := upstream.RecvMsg(&frame)
		if recvErr != nil {
			downstream.SetTrailer(upstream.Trailer())
			if recvErr == io.EOF {
				return nil
			}
			return recvErr
		}
		if err := downstream.SendMsg(&frame); err != nil {
			return err
		}
		select {
		case clientErr := <-clientResult:
			if clientErr != nil && clientErr != io.EOF {
				return clientErr
			}
		default:
		}
	}
}

func sanitizeMetadata(source metadata.MD) metadata.MD {
	result := metadata.MD{}
	for key, values := range source {
		if strings.HasPrefix(strings.ToLower(key), metadataPrefix) {
			continue
		}
		result[key] = append([]string(nil), values...)
	}
	return result
}
