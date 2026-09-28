package relaybridge

import (
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ProbeReachedGatedEndpoint reports a source probe the relay refused only
// because the target is an Availability member that takes no traffic now: the
// lease gate is closed for it (a standby holds no committed slot) or it is
// registered dormant. The relay checks the connect grant and finds the route
// and its endpoint before it asks the gate, so such a refusal proves what the
// probe verifies: the source reaches the relay and the relay authorizes the
// staged route. A member is placed on every lease relay whatever its lease
// state; failing its move for being a standby kept the pool degraded (B-17).
func ProbeReachedGatedEndpoint(err error) bool {
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.FailedPrecondition:
		return strings.Contains(current.Message(), "availability lease gate closed")
	case codes.Unavailable:
		return strings.Contains(current.Message(), "target endpoint is dormant")
	}
	return false
}
