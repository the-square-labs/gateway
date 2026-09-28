package relaybridge

import (
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestProbeReachedGatedEndpoint(t *testing.T) {
	for name, test := range map[string]struct {
		err  error
		want bool
	}{
		"standby without a slot": {status.Error(codes.FailedPrecondition, "availability lease gate closed: b839311a holds no committed slot"), true},
		"dormant member":         {status.Error(codes.Unavailable, "target endpoint is dormant"), true},
		"not registered":         {status.Error(codes.Unavailable, "target endpoint is not registered"), false},
		"grant refused":          {status.Error(codes.PermissionDenied, "connect grant route was revoked"), false},
		"other precondition":     {status.Error(codes.FailedPrecondition, "renewal changes endpoint identity"), false},
		"plain error":            {errors.New("availability lease gate closed"), false},
		"no error":               {nil, false},
	} {
		if got := ProbeReachedGatedEndpoint(test.err); got != test.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}
