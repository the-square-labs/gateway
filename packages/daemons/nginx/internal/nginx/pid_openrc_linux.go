//go:build linux

package nginx

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Binary-only upgrades do not rerun setup-node.sh. The stock Alpine OpenRC
// service assigns /run/nginx to nginx on both start and reload. Take ownership
// of only that known directory, without trusting or changing its contents.
// readTrustedPIDFile still rejects symlinks, hard links and non-root PID files.
func prepareOpenRCPIDDirectory(pidFile string) error {
	if os.Geteuid() != 0 || (pidFile != "/run/nginx/nginx.pid" && pidFile != "/var/run/nginx/nginx.pid") {
		return nil
	}
	if validateTrustedPIDParents("/run/nginx") == nil {
		return nil
	}
	service, err := readTrustedPIDFile("/etc/init.d/nginx")
	if err != nil {
		return nil // Unknown installations retain the strict PID validation.
	}
	source := string(service)
	if !strings.HasPrefix(source, "#!/sbin/openrc-run\n") ||
		!strings.Contains(source, "\npidfile=/run/nginx/nginx.pid\n") ||
		(!strings.Contains(source, "checkpath --directory --owner nginx:nginx ${pidfile%/*}") &&
			!strings.Contains(source, "checkpath --directory --mode 0755 --owner root:root ${pidfile%/*}")) {
		return nil
	}
	if err := validateTrustedPIDParents("/run"); err != nil {
		return err
	}
	parent, err := unix.Open("/run", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	directory, err := unix.Openat(parent, "nginx", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open OpenRC nginx PID directory: %w", err)
	}
	defer unix.Close(directory)
	var stat unix.Stat_t
	if err := unix.Fstat(directory, &stat); err != nil {
		return err
	}
	account, err := user.Lookup("nginx")
	if err != nil {
		return err
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return err
	}
	if (stat.Uid != 0 && stat.Uid != uint32(uid)) || stat.Mode&0o002 != 0 {
		return fmt.Errorf("unexpected owner or permissions on OpenRC nginx PID directory")
	}
	if err := unix.Fchown(directory, 0, 0); err != nil {
		return err
	}
	return unix.Fchmod(directory, 0o755)
}
