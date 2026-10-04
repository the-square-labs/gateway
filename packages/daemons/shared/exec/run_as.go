package exec

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

// Linux capability bits a process needs to start a child as another user:
// setgroups/setgid and setuid.
const (
	capSetgid = 6
	capSetuid = 7
)

// ErrCannotSwitchUser marks a run-as user that this process cannot start
// processes as, because it is neither root nor holds CAP_SETUID and
// CAP_SETGID.
var ErrCannotSwitchUser = errors.New("cannot start processes as another user")

// Seams for tests: the process identity and its effective capabilities.
var (
	processEUID       = os.Geteuid
	processCanSetUser = effectiveCapabilitiesAllowUserSwitch
)

// runAsTarget is how a command runs as a configured user.
type runAsTarget struct {
	credential *syscall.Credential // nil when the user is this process's own
	home       string
	dir        string
}

// CheckRunAsUser reports whether this process can start commands as username.
// Empty and the process's own user always work. Another user needs root or
// CAP_SETUID and CAP_SETGID; without them the error wraps ErrCannotSwitchUser,
// also when the user does not exist, since it cannot be the process's own.
func CheckRunAsUser(username string) error {
	if username == "" {
		return nil
	}
	account, lookupErr := user.Lookup(username)
	if lookupErr == nil && isProcessUser(account) {
		return nil
	}
	if processEUID() != 0 && !processCanSetUser() {
		return fmt.Errorf("the daemon runs as %s without root and %w", processUserName(), ErrCannotSwitchUser)
	}
	return lookupErr
}

func resolveRunAsUser(username string) (runAsTarget, error) {
	if err := CheckRunAsUser(username); err != nil {
		return runAsTarget{}, err
	}
	account, err := user.Lookup(username)
	if err != nil {
		return runAsTarget{}, err
	}
	target := runAsTarget{home: account.HomeDir, dir: workingDirectory(account.HomeDir)}
	if isProcessUser(account) {
		return target, nil
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return runAsTarget{}, fmt.Errorf("user %q has an invalid uid %q", username, account.Uid)
	}
	gid, err := strconv.ParseUint(account.Gid, 10, 32)
	if err != nil {
		return runAsTarget{}, fmt.Errorf("user %q has an invalid gid %q", username, account.Gid)
	}
	target.credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
	return target, nil
}

// applyRunAsUser makes cmd run as username, in its home directory when that
// exists and in / otherwise.
func applyRunAsUser(cmd *osexec.Cmd, username string) error {
	if username == "" {
		return nil
	}
	target, err := resolveRunAsUser(username)
	if err != nil {
		return fmt.Errorf("cannot run as user %q: %w", username, err)
	}
	if target.credential != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: target.credential}
	}
	cmd.Dir = target.dir
	cmd.Env = append(cmd.Env, "HOME="+target.home, "USER="+username)
	return nil
}

// workingDirectory is home when it is a directory, else /. System users are
// often created without a home (useradd --no-create-home, /nonexistent).
func workingDirectory(home string) string {
	if home != "" {
		if info, err := os.Stat(home); err == nil && info.IsDir() {
			return home
		}
	}
	return "/"
}

// isProcessUser is true for this process's own user, which needs no switch:
// the command keeps the process's groups.
func isProcessUser(account *user.User) bool {
	return account.Uid == strconv.Itoa(processEUID())
}

func processUserName() string {
	uid := strconv.Itoa(processEUID())
	if account, err := user.LookupId(uid); err == nil {
		return account.Username
	}
	return "uid " + uid
}

// effectiveCapabilitiesAllowUserSwitch reads CapEff of this process; it is
// false where /proc is unavailable.
func effectiveCapabilitiesAllowUserSwitch() bool {
	file, err := os.Open("/proc/self/status")
	if err != nil {
		return false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		value, found := strings.CutPrefix(scanner.Text(), "CapEff:")
		if !found {
			continue
		}
		capabilities, err := strconv.ParseUint(strings.TrimSpace(value), 16, 64)
		if err != nil {
			return false
		}
		required := uint64(1)<<capSetuid | uint64(1)<<capSetgid
		return capabilities&required == required
	}
	return false
}
