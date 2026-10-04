package watchdog

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func ownerOf(t *testing.T, path string) (int, int) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	return int(stat.Uid), int(stat.Gid)
}

// A switch of the docker daemon's user leaves the records directory and the records the previous daemon wrote to the
// previous user, and the new daemon could not read them. Every pass hands them to the daemon's user, in both
// directions; a link planted among the records never hands over a file elsewhere.
func TestRecordsFollowTheDaemonUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("handing files to another user needs root")
	}
	h := newHarness(t)
	h.record(h.now+time.Minute, "")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(h.dir.RecordsDir(), "linked.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(h.dir.RecordsDir(), "symlinked.json")); err != nil {
		t.Fatal(err)
	}
	uid, gid := 65534, 65534
	h.dog.cfg.Owner = func() (int, int, bool) { return uid, gid, true }
	h.dog.Pass()
	record := filepath.Join(h.dir.RecordsDir(), containerID+".json")
	for _, path := range []string{h.dir.RecordsDir(), record} {
		if u, g := ownerOf(t, path); u != uid || g != gid {
			t.Fatalf("%s owned by %d:%d, want %d:%d", path, u, g, uid, gid)
		}
	}
	if u, _ := ownerOf(t, outside); u != 0 {
		t.Fatalf("a file linked into the records was handed over (uid %d)", u)
	}
	// Back to root.
	uid, gid = 0, 0
	h.dog.Pass()
	for _, path := range []string{h.dir.RecordsDir(), record} {
		if u, g := ownerOf(t, path); u != 0 || g != 0 {
			t.Fatalf("%s owned by %d:%d after the switch back to root", path, u, g)
		}
	}
}

// The owner follows the daemon's configuration directory; the --records-owner flag stands in only without it.
func TestRecordsOwnerFollowsTheDaemonConfigDirectory(t *testing.T) {
	dir := t.TempDir()
	owner := func() (int, int, bool) { return 4242, 4242, true }
	if uid, gid, ok := ConfigDirOwner(dir, owner)(); !ok || uid != os.Geteuid() || gid != os.Getegid() {
		t.Fatalf("owner %d:%d %v, want the configuration directory's", uid, gid, ok)
	}
	if uid, _, ok := ConfigDirOwner(filepath.Join(dir, "missing"), owner)(); !ok || uid != 4242 {
		t.Fatalf("owner %d %v without the configuration directory, want the flag's", uid, ok)
	}
}
