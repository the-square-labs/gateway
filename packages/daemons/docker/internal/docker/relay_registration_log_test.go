package docker

import (
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// rc.10 upgrade run, F-4: a daemon update and a relay update logged the end
// of the endpoint registration as a warning.
func TestRelayRegistrationPlannedEnd(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"policy moved on", status.Error(codes.Aborted, "endpoint policy was revoked"), true},
		{"relay stopping for its update", status.Error(codes.Unavailable, `closing transport due to: x, received prior goaway: code: NO_ERROR, debug data: "graceful_stop"`), true},
		{"lease gate closed", status.Error(codes.Aborted, "availability lease gate closed: expired"), false},
		{"restart not finished", status.Error(codes.Aborted, "target endpoint did not finish its restart"), false},
		{"refused", status.Error(codes.PermissionDenied, "grant does not match policy"), false},
		{"relay unreachable", status.Error(codes.Unavailable, "connection refused"), false},
	}
	for _, c := range cases {
		if got := relayRegistrationPlannedEnd(c.err); got != c.want {
			t.Errorf("%s: relayRegistrationPlannedEnd = %v, want %v", c.name, got, c.want)
		}
	}
}
