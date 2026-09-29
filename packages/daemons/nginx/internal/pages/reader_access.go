package pages

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// errReleaseUnreadable is a stored release nginx workers cannot reach, so it
// is not reported ready (N-22).
var errReleaseUnreadable = errors.New("nginx workers cannot read the Pages release")

// SetReaderAccess names the directory tree the runtime may make traversable
// for nginx workers (the daemon's state directory, which holds the Pages
// root) and the uid the workers run as. Without a worker uid (nginx not
// running yet) a release must be reachable by every other user.
func (r *Runtime) SetReaderAccess(base string, workerUID func() (int, error)) {
	r.traversableBase = filepath.Clean(base)
	r.workerUID = workerUID
}

// RepairTraversal lets nginx workers reach the Pages root (N-22): every
// directory from the traversable base down to the root's parent that other
// users cannot search gets search permission for them. Search only: listing
// stays with the owner, and every file and subdirectory keeps its own mode, so
// the daemon's private state stays private. A directory another user owns is
// left alone.
func (r *Runtime) RepairTraversal() error {
	base := r.traversableBase
	if base == "" || base == "." || base == string(filepath.Separator) || !filepath.IsAbs(base) {
		return nil
	}
	for dir := filepath.Dir(filepath.Clean(r.root)); dir == base || strings.HasPrefix(dir, base+string(filepath.Separator)); dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if err := validateDirectoryInfo(dir, info); err != nil {
			return err
		}
		if info.Mode().Perm()&0o001 == 0 {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || int(stat.Uid) != os.Geteuid() {
				return fmt.Errorf("%w: %s is not owned by the daemon", errReleaseUnreadable, dir)
			}
			if err := chmodNoFollowDirectory(dir, info.Mode().Perm()|0o001); err != nil {
				return err
			}
		}
		if dir == base {
			break
		}
	}
	return nil
}

// checkReaderAccess verifies that nginx workers can reach a release's content:
// every directory from / down to it must be searchable by them. The release
// files themselves are made world-readable by ensurePublicRelease. When a
// directory in the daemon's own tree blocks them, the traversal is repaired
// once and checked again.
func (r *Runtime) checkReaderAccess(contentDir string) error {
	if r.workerUID == nil && r.traversableBase == "" {
		// SetReaderAccess was not called (tests): no reader to check for.
		return nil
	}
	err := r.readerCanReach(contentDir)
	if err == nil || r.RepairTraversal() != nil {
		return err
	}
	return r.readerCanReach(contentDir)
}

func (r *Runtime) readerCanReach(contentDir string) error {
	uid, groups := -1, map[uint32]bool{}
	if r.workerUID != nil {
		if workerUID, err := r.workerUID(); err == nil {
			uid, groups = workerUID, workerGroups(workerUID)
		}
	}
	if uid == 0 {
		return nil
	}
	for dir := filepath.Clean(contentDir); ; dir = filepath.Dir(dir) {
		info, err := os.Stat(dir)
		if err != nil {
			return err
		}
		if !searchable(info, uid, groups) {
			return fmt.Errorf("%w: %s is not searchable for them", errReleaseUnreadable, dir)
		}
		if parent := filepath.Dir(dir); parent == dir {
			return nil
		}
	}
}

// searchable reports whether uid (or, for uid -1, any other user) may search
// the directory, by its permission bits.
func searchable(info os.FileInfo, uid int, groups map[uint32]bool) bool {
	perm := info.Mode().Perm()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return perm&0o001 != 0
	}
	switch {
	case uid >= 0 && int(stat.Uid) == uid:
		return perm&0o100 != 0
	case uid >= 0 && groups[stat.Gid]:
		return perm&0o010 != 0
	default:
		return perm&0o001 != 0
	}
}

// workerGroups are the group ids of a worker uid's account, or none when the
// account is unknown (its directories are then checked as another user's).
func workerGroups(uid int) map[uint32]bool {
	groups := map[uint32]bool{}
	account, err := user.LookupId(strconv.Itoa(uid))
	if err != nil {
		return groups
	}
	ids, err := account.GroupIds()
	if err != nil {
		ids = []string{account.Gid}
	}
	for _, id := range ids {
		if gid, err := strconv.ParseUint(id, 10, 32); err == nil {
			groups[uint32(gid)] = true
		}
	}
	return groups
}
