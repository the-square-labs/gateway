package listenerkeep

import (
	"os"
	"syscall"
)

const notifyOnBehalfSupported = true

// notifyCredentials is the SCM_CREDENTIALS control message that sends a
// notification as pid (sd_pid_notify_with_fds).
func notifyCredentials(pid int) []byte {
	return syscall.UnixCredentials(&syscall.Ucred{Pid: int32(pid), Uid: uint32(os.Getuid()), Gid: uint32(os.Getgid())})
}
