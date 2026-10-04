package watchdog

import (
	"os"
	"path/filepath"
	"syscall"
)

// Owner returns the user the deadline records belong to: the docker daemon's, which writes and reads them. ok is
// false when it is unknown; the records then keep their owners.
type Owner func() (uid, gid int, ok bool)

// ConfigDirOwner follows the user that runs docker-daemon: the owner of its configuration directory, which the node
// installer gives that user, and gives back to root when the daemon runs as root again. fallback (the
// --records-owner of the service file) stands in only without that directory: a switch of the daemon's user may leave
// the service file, and so the flag, as it was.
func ConfigDirOwner(configDir string, fallback Owner) Owner {
	return func() (int, int, bool) {
		if info, err := os.Stat(configDir); err == nil && info.IsDir() {
			if stat, ok := info.Sys().(*syscall.Stat_t); ok {
				return int(stat.Uid), int(stat.Gid), true
			}
		}
		return fallback()
	}
}

// alignOwner hands the records directory and every record in it to the docker daemon's user. A switch of that user
// leaves the directory, and the records the previous user's daemon wrote, to the previous user (0700 and 0600): the
// new daemon could neither renew them nor tell which running copy is fenced. Only the records directory and the
// regular files in it with a single link are changed, through descriptors opened without following links, so a
// name planted there never hands over a file elsewhere.
func (w *Watchdog) alignOwner() {
	if w.cfg.Owner == nil {
		return
	}
	uid, gid, ok := w.cfg.Owner()
	if !ok {
		return
	}
	dir := w.cfg.Dir.RecordsDir()
	if err := chownOpened(dir, syscall.O_DIRECTORY, uid, gid, true); err != nil {
		if !os.IsNotExist(err) {
			w.ownerProblem(dir, err)
		}
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		w.ownerProblem(dir, err)
		return
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		if err := chownOpened(path, 0, uid, gid, false); err != nil && !os.IsNotExist(err) {
			w.ownerProblem(path, err)
		}
	}
}

// chownOpened gives uid:gid the file at path, opened without following a symbolic link: a directory when directory
// is set, else a regular file with no other link.
func chownOpened(path string, flags, uid, gid int, directory bool) error {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC|flags, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.IsDir() != directory || (!directory && (!info.Mode().IsRegular() || stat.Nlink != 1)) {
		return nil
	}
	if int(stat.Uid) == uid && int(stat.Gid) == gid {
		return nil
	}
	return file.Chown(uid, gid)
}

// ownerProblem logs a failed hand-over once per path and error.
func (w *Watchdog) ownerProblem(path string, err error) {
	key := "owner " + path + ": " + err.Error()
	if w.problems[key] {
		return
	}
	w.problems[key] = true
	w.cfg.Logger.Warn("lease watchdog could not hand a deadline record over to the docker daemon's user", "path", path, "error", err)
}
