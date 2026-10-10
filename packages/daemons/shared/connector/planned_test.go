package connector

import (
	"errors"
	"fmt"
	"io"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestPlannedDisconnect(t *testing.T) {
	for _, tc := range []struct {
		err     error
		planned bool
	}{
		{io.EOF, true},
		{fmt.Errorf("recv: %w", io.EOF), true},
		{status.Error(codes.Unavailable, `closing transport due to: connection error: desc = "error reading from server: EOF", received prior goaway: code: NO_ERROR, debug data: "graceful_stop"`), true},
		{status.Error(codes.Canceled, "grpc: the client connection is closing"), true},
		{status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 127.0.0.1:9443: connect: connection refused\""), false},
		{status.Error(codes.Canceled, "context canceled"), false},
		{errors.New("reset by peer"), false},
	} {
		if got := PlannedDisconnect(tc.err); got != tc.planned {
			t.Errorf("%v: planned %v, want %v", tc.err, got, tc.planned)
		}
	}
}
