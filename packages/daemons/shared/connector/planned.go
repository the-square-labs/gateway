package connector

import (
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PlannedDisconnect reports a stream that ended because its peer or this
// process closed it on purpose: the peer stopped gracefully or drained the
// connection (a relay or Gateway restarting for an update sends GOAWAY
// "graceful_stop" first), the stream ended cleanly (EOF), or this process
// closed the connection (a planned control reconnect after a launcher
// update), or the peer cancelled the stream itself (RST_STREAM CANCEL: a
// Gateway shutting down for its update or restart ends its streams so;
// a peer that fails drops the connection instead). Such an end is logged as
// information, not as a warning (stand rc.10 O-2, rc.11 upgrade run N-2).
func PlannedDisconnect(err error) bool {
	if err == nil || PlannedServerStop(err) {
		return true
	}
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.Canceled:
		return strings.Contains(current.Message(), "client connection is closing") ||
			strings.Contains(current.Message(), "RST_STREAM with error code: CANCEL")
	case codes.Unavailable:
		return strings.Contains(current.Message(), "graceful_stop")
	}
	return false
}
