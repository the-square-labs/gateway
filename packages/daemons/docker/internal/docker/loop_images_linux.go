package docker

import "golang.org/x/sys/unix"

// loopBackingIdentity reads the backing file's device and inode from the loop
// device itself. It fails for device nodes this daemon cannot open, such as
// loop devices of the host or of other guests listed in an LXC guest's sysfs.
func loopBackingIdentity(device string) (uint64, uint64, bool) {
	fd, err := unix.Open(device, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, 0, false
	}
	defer unix.Close(fd)
	info, err := unix.IoctlLoopGetStatus64(fd)
	if err != nil {
		return 0, 0, false
	}
	return info.Device, info.Inode, true
}
