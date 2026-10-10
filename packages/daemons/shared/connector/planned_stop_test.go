package connector

import (
	"errors"
	"fmt"
	"io"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestPlannedServerStop(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"graceful GOAWAY of a stopping relay", status.Error(codes.Unavailable, `closing transport due to: connection error: desc = "error reading from server: EOF", received prior goaway: code: NO_ERROR, debug data: "graceful_stop"`), true},
		{"draining connection", status.Error(codes.Unavailable, "the connection is draining"), true},
		{"stream closed normally", fmt.Errorf("receive: %w", io.EOF), true},
		{"GOAWAY for an error", status.Error(codes.Unavailable, "closing transport due to: x, received prior goaway: code: ENHANCE_YOUR_CALM"), false},
		{"server unreachable", status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: connection refused\""), false},
		{"refused", status.Error(codes.PermissionDenied, "node revoked"), false},
		{"other", errors.New("boom"), false},
		{"none", nil, false},
	}
	for _, c := range cases {
		if got := PlannedServerStop(c.err); got != c.want {
			t.Errorf("%s: PlannedServerStop = %v, want %v", c.name, got, c.want)
		}
	}
}
