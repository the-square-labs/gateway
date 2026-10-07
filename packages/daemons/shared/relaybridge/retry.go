package relaybridge

import (
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// RetryableOpenError reports a source tunnel open that is worth another try
// shortly: a relay that is restarting (lane transport not ready, stream
// broken) or a target that has not registered yet (its daemon is restarting).
// A closed lease gate, a dormant availability member, a session limit or a
// grant the relay rejects are final.
func RetryableOpenError(err error) bool {
	current, ok := status.FromError(err)
	if !ok || current.Code() != codes.Unavailable {
		return false
	}
	message := current.Message()
	return !strings.Contains(message, "dormant") && !strings.Contains(message, "built-in local service")
}

// TargetRestarting reports a refusal for a target whose daemon announced a
// graceful restart (B-13): its next process registers within seconds.
func TargetRestarting(err error) bool {
	current, ok := status.FromError(err)
	return ok && current.Code() == codes.Unavailable && strings.Contains(current.Message(), "target endpoint is restarting")
}
