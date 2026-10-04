package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// GatewaySessionFile, in the daemon state directory, records the last control
// session Gateway accepted, or why the enrollment before it failed. The
// installers remove it before they start the daemon and wait for it, so a
// daemon that runs but never reaches Gateway, or does not run at all, fails the
// install instead of passing it, and a refused token is named as such.
const GatewaySessionFile = "gateway-session.json"

type gatewaySessionRecord struct {
	PID         int    `json:"pid"`
	Version     string `json:"version"`
	ConnectedAt int64  `json:"connected_at,omitempty"`
	// EnrollmentRefused: Gateway refused the enrollment token (used, expired,
	// or for another node or host), so retrying it cannot succeed.
	EnrollmentRefused bool   `json:"enrollment_refused,omitempty"`
	EnrollmentError   string `json:"enrollment_error,omitempty"`
}

// recordGatewaySession notes that Gateway accepted this process's control
// session at the given time.
func recordGatewaySession(stateDir string, connectedAt time.Time) error {
	return writeGatewaySessionRecord(stateDir, gatewaySessionRecord{ConnectedAt: connectedAt.Unix()})
}

// recordEnrollmentFailure notes why this process could not enroll.
func recordEnrollmentFailure(stateDir string, enrollErr error) error {
	return writeGatewaySessionRecord(stateDir, gatewaySessionRecord{
		EnrollmentRefused: enrollmentTokenRefused(enrollErr),
		EnrollmentError:   enrollErr.Error(),
	})
}

// enrollmentTokenRefused reports whether Gateway answered the enrollment and
// refused its token, rather than not being reached.
func enrollmentTokenRefused(err error) bool {
	switch status.Code(err) {
	case codes.Unauthenticated, codes.PermissionDenied, codes.InvalidArgument, codes.AlreadyExists, codes.FailedPrecondition:
		return true
	default:
		return false
	}
}

func writeGatewaySessionRecord(stateDir string, record gatewaySessionRecord) error {
	record.PID, record.Version = os.Getpid(), Version
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(stateDir, GatewaySessionFile), append(encoded, '\n'), 0o600)
}
