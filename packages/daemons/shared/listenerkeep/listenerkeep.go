// Package listenerkeep keeps a daemon's listening sockets open while the
// daemon process restarts, so a connection made in between waits in the
// socket's backlog for the next process instead of being refused.
//
// A listener survives in a keeper that outlives the daemon process:
//
//   - the daemon launcher, which starts every daemon process of a unit in turn
//     (update handoffs, crashes). A daemon hands it a copy of each listener
//     over a datagram channel, and the launcher hands every copy it holds to
//     the next daemon process;
//   - systemd's file descriptor store (FileDescriptorStoreMax=), which outlives
//     a restart of the whole unit. The launcher, or a daemon running without
//     one as the unit's main process, stores each copy there, and systemd
//     passes them back through LISTEN_FDS on the next start.
//
// A kept listener is named by its socket path and the inode of the socket file
// (Name): a process adopts a kept listener only while the path still names
// that very socket, never one a different process re-created in between.
package listenerkeep

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// ChannelFDEnv names the descriptor of the datagram channel to the launcher.
	ChannelFDEnv = "GATEWAY_DAEMON_LISTENER_KEEP_FD"
	// KeptEnv lists the listeners the launcher handed this process: a JSON
	// array of {"name", "fd"}.
	KeptEnv = "GATEWAY_DAEMON_KEPT_LISTENERS"
	// launcherManagedEnv mirrors lifecycle.LauncherManagedEnv: a daemon started
	// by a launcher is not the unit's main process, so it must never talk to
	// systemd's notification socket itself.
	launcherManagedEnv = "GATEWAY_DAEMON_LAUNCHER_MANAGED"

	messageKeep = "keep"
	messageDrop = "drop"
	messageSync = "sync"

	// sendTimeout bounds a message to a launcher that stopped reading: the
	// listener is then simply not kept.
	sendTimeout = time.Second
	maxMessage  = 8192
)

type keptDescriptor struct {
	Name string `json:"name"`
	FD   int    `json:"fd"`
}

// Name is the keeper name of the Unix listener bound at socketPath: the path
// and the inode of the socket file it created there.
func Name(socketPath string) (string, error) {
	info, err := os.Lstat(socketPath)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return "", fmt.Errorf("%s is not a socket", socketPath)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("socket inode is unavailable")
	}
	return socketPath + "#" + strconv.FormatUint(uint64(stat.Ino), 10), nil
}

// NamePath is the socket path part of a keeper name.
func NamePath(name string) string {
	if index := strings.LastIndex(name, "#"); index >= 0 {
		return name[:index]
	}
	return name
}

type client struct {
	mu        sync.Mutex
	inherited map[string]*os.File
	send      func(message string, file *os.File) error
}

var (
	initOnce sync.Once
	global   = &client{inherited: map[string]*os.File{}}
)

// Init takes over what the launcher or systemd handed this process and marks
// every inherited descriptor close-on-exec, so no helper process started
// later inherits a listener. Call it before starting any other process; later
// calls do nothing.
func Init() {
	initOnce.Do(func() {
		fresh := newClientFromEnvironment()
		globalMu.Lock()
		global = fresh
		globalMu.Unlock()
	})
}

// ReinitForTest replaces this process's keeper client with one read from the
// environment again. Tests only.
func ReinitForTest() {
	initOnce.Do(func() {})
	fresh := newClientFromEnvironment()
	globalMu.Lock()
	global = fresh
	globalMu.Unlock()
}

var globalMu sync.Mutex

func current() *client {
	Init()
	globalMu.Lock()
	defer globalMu.Unlock()
	return global
}

// Available reports whether a listener handed to Keep survives a restart.
func Available() bool { return current().available() }

// Take returns the descriptor a previous process kept under name, which the
// caller now owns, and forgets it.
func Take(name string) (*os.File, bool) { return current().take(name) }

// Inherited lists the names of the descriptors still unclaimed whose socket
// path starts with prefix.
func Inherited(prefix string) []string { return current().unclaimed(prefix) }

// Keep hands a copy of file to the keeper under name, replacing a copy kept
// under that name. The caller keeps, and eventually closes, its own file.
func Keep(name string, file *os.File) error { return current().keep(name, file) }

// Drop tells the keeper to close its copy kept under name.
func Drop(name string) error { return current().drop(name) }

// ReleaseUnclaimed closes every inherited descriptor under prefix that no
// Take claimed, here and in the keeper, and returns their names.
func ReleaseUnclaimed(prefix string) []string { return current().releaseUnclaimed(prefix) }

func (c *client) available() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.send != nil
}

func (c *client) take(name string) (*os.File, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, ok := c.inherited[name]
	if ok {
		delete(c.inherited, name)
	}
	return file, ok
}

func (c *client) unclaimed(prefix string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := make([]string, 0, len(c.inherited))
	for name := range c.inherited {
		if strings.HasPrefix(NamePath(name), prefix) {
			names = append(names, name)
		}
	}
	return names
}

func (c *client) keep(name string, file *os.File) error {
	c.mu.Lock()
	send := c.send
	c.mu.Unlock()
	if send == nil {
		return nil
	}
	if file == nil {
		return errors.New("no listener to keep")
	}
	return send(messageKeep+"\n"+name, file)
}

func (c *client) drop(name string) error {
	c.mu.Lock()
	send := c.send
	c.mu.Unlock()
	if send == nil || name == "" {
		return nil
	}
	return send(messageDrop+"\n"+name, nil)
}

func (c *client) releaseUnclaimed(prefix string) []string {
	c.mu.Lock()
	released := make(map[string]*os.File)
	for name, file := range c.inherited {
		if strings.HasPrefix(NamePath(name), prefix) {
			released[name] = file
			delete(c.inherited, name)
		}
	}
	c.mu.Unlock()
	names := make([]string, 0, len(released))
	for name, file := range released {
		_ = c.drop(name)
		_ = file.Close()
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func newClientFromEnvironment() *client {
	current := &client{inherited: map[string]*os.File{}}
	if os.Getenv(launcherManagedEnv) == "1" {
		kept := os.Getenv(KeptEnv)
		channel := os.Getenv(ChannelFDEnv)
		_ = os.Unsetenv(KeptEnv)
		_ = os.Unsetenv(ChannelFDEnv)
		var descriptors []keptDescriptor
		if kept != "" && json.Unmarshal([]byte(kept), &descriptors) == nil {
			for _, descriptor := range descriptors {
				if descriptor.FD < 3 || descriptor.Name == "" {
					continue
				}
				syscall.CloseOnExec(descriptor.FD)
				current.inherited[descriptor.Name] = os.NewFile(uintptr(descriptor.FD), descriptor.Name)
			}
		}
		// An older launcher sets neither: nothing is kept, and this process is
		// not the unit's main process, so systemd would refuse it anyway.
		if fd, err := strconv.Atoi(channel); err == nil && fd >= 3 {
			syscall.CloseOnExec(fd)
			file := os.NewFile(uintptr(fd), "listener-keep")
			connection, err := net.FileConn(file)
			_ = file.Close()
			if unixConnection, ok := connection.(*net.UnixConn); err == nil && ok {
				current.send = func(message string, file *os.File) error {
					return sendMessage(unixConnection, message, file)
				}
			}
		}
		return current
	}
	for name, file := range takeSystemdListeners() {
		current.inherited[name] = file
	}
	if notify := dialNotifySocket(); notify != nil {
		current.send = func(message string, file *os.File) error {
			return forwardToSystemd(notify, message, file)
		}
	}
	return current
}

func sendMessage(connection *net.UnixConn, message string, file *os.File) error {
	if len(message) > maxMessage {
		return errors.New("listener keep message is too long")
	}
	_ = connection.SetWriteDeadline(time.Now().Add(sendTimeout))
	return withDescriptor(file, func(rights []byte) error {
		_, _, err := connection.WriteMsgUnix([]byte(message), rights, nil)
		return err
	})
}

// withDescriptor runs send with the SCM_RIGHTS control message carrying file
// (none for a nil file). It never calls file.Fd(): that switches the
// descriptor to blocking mode, and the mode belongs to the socket every copy
// shares, so a listener still accepting in this or another process would
// block in accept() and could no longer be closed.
func withDescriptor(file *os.File, send func(rights []byte) error) error {
	if file == nil {
		return send(nil)
	}
	raw, err := file.SyscallConn()
	if err != nil {
		return err
	}
	var sendErr error
	if err := raw.Control(func(fd uintptr) {
		sendErr = send(syscall.UnixRights(int(fd)))
	}); err != nil {
		return err
	}
	return sendErr
}

// takeSystemdListeners adopts the descriptors systemd passed this process
// (sd_listen_fds with names) and clears the variables so no helper process
// reads them.
func takeSystemdListeners() map[string]*os.File {
	return takeListenFDs(3)
}

// takeListenFDs reads sd_listen_fds for descriptors numbered from first (3
// outside tests).
func takeListenFDs(first int) map[string]*os.File {
	pid := os.Getenv("LISTEN_PID")
	count := os.Getenv("LISTEN_FDS")
	names := os.Getenv("LISTEN_FDNAMES")
	if pid == "" && count == "" {
		return nil
	}
	_ = os.Unsetenv("LISTEN_PID")
	_ = os.Unsetenv("LISTEN_FDS")
	_ = os.Unsetenv("LISTEN_FDNAMES")
	if pid != strconv.Itoa(os.Getpid()) {
		return nil
	}
	n, err := strconv.Atoi(count)
	if err != nil || n <= 0 {
		return nil
	}
	nameList := strings.Split(names, ":")
	files := make(map[string]*os.File, n)
	for index := 0; index < n; index++ {
		fd := first + index
		syscall.CloseOnExec(fd)
		name := ""
		if index < len(nameList) {
			name = nameList[index]
		}
		if name == "" || name == "unknown" || name == "stored" {
			// Not one of ours: keep it closed rather than guessing.
			_ = syscall.Close(fd)
			continue
		}
		files[name] = os.NewFile(uintptr(fd), name)
	}
	return files
}

// notifySocket sends to systemd's notification socket. The socket is not
// connected: a connected datagram socket cannot carry descriptors in Go.
type notifySocket struct {
	fd      int
	address *syscall.SockaddrUnix
}

func dialNotifySocket() *notifySocket {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" || (!strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "@")) {
		return nil
	}
	syscall.ForkLock.RLock()
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_DGRAM, 0)
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil
	}
	return &notifySocket{fd: fd, address: &syscall.SockaddrUnix{Name: path}}
}

func (n *notifySocket) send(message string, file *os.File) error {
	return withDescriptor(file, func(rights []byte) error {
		return syscall.Sendmsg(n.fd, []byte(message), rights, n.address, 0)
	})
}

func (n *notifySocket) close() {
	_ = syscall.Close(n.fd)
}

// forwardToSystemd stores or removes a kept listener in systemd's file
// descriptor store (sd_pid_notify_with_fds FDSTORE=1 / FDSTOREREMOVE=1).
func forwardToSystemd(notify *notifySocket, message string, file *os.File) error {
	kind, name, ok := strings.Cut(message, "\n")
	if !ok || name == "" || strings.ContainsAny(name, ":\n") {
		return errors.New("invalid listener keep message")
	}
	if err := notify.send("FDSTOREREMOVE=1\nFDNAME="+name+"\n", nil); err != nil {
		return err
	}
	if kind != messageKeep {
		return nil
	}
	if file == nil {
		return errors.New("listener keep message carries no descriptor")
	}
	return notify.send("FDSTORE=1\nFDNAME="+name+"\n", file)
}
