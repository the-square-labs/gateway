// Package handovertest provides a keeper for tests of live handover: the
// launcher's keeper of one daemon, in memory.
package handovertest

import (
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Keeper is the launcher's keeper of one daemon (handover.Keeper): its own
// copy of every descriptor a process kept, and the copies the current process
// inherited at its start.
type Keeper struct {
	mu        sync.Mutex
	store     map[string]*os.File
	inherited map[string]*os.File
}

// NewKeeper creates an empty keeper.
func NewKeeper() *Keeper {
	return &Keeper{store: map[string]*os.File{}, inherited: map[string]*os.File{}}
}

func duplicate(file *os.File) (*os.File, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return nil, err
	}
	duplicated := -1
	var dupErr error
	if err := raw.Control(func(fd uintptr) { duplicated, dupErr = syscall.Dup(int(fd)) }); err != nil {
		return nil, err
	}
	if dupErr != nil {
		return nil, dupErr
	}
	syscall.CloseOnExec(duplicated)
	return os.NewFile(uintptr(duplicated), file.Name()), nil
}

// HandsOver reports a keeper that passes what it keeps to the next process.
func (k *Keeper) HandsOver() bool { return true }

// Keep stores a copy of file under name.
func (k *Keeper) Keep(name string, file *os.File) error {
	copied, err := duplicate(file)
	if err != nil {
		return err
	}
	k.mu.Lock()
	previous := k.store[name]
	k.store[name] = copied
	k.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	return nil
}

// Drop closes the copy kept under name.
func (k *Keeper) Drop(name string) error {
	k.mu.Lock()
	previous := k.store[name]
	delete(k.store, name)
	k.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	return nil
}

// Take hands the current process the copy it inherited under name.
func (k *Keeper) Take(name string) (*os.File, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	file, ok := k.inherited[name]
	delete(k.inherited, name)
	return file, ok
}

// Inherited lists the names the current process inherited under prefix and
// did not take.
func (k *Keeper) Inherited(prefix string) []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	var names []string
	for name := range k.inherited {
		if strings.HasPrefix(name, prefix) {
			names = append(names, name)
		}
	}
	return names
}

// Flush returns at once: the keeper applies every message when it is sent.
func (k *Keeper) Flush(time.Duration) error { return nil }

// EnvBytes estimates the launcher's description of what it passes on.
func (k *Keeper) EnvBytes(names []string) int {
	k.mu.Lock()
	defer k.mu.Unlock()
	size := 0
	for name := range k.store {
		size += len(name) + 25
	}
	for _, name := range names {
		size += len(name) + 25
	}
	return size
}

// Restart is the next process starting: the previous process's inherited
// copies closed with it, and the new one inherits a copy of everything kept.
func (k *Keeper) Restart() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, file := range k.inherited {
		_ = file.Close()
	}
	k.inherited = map[string]*os.File{}
	for name, file := range k.store {
		copied, err := duplicate(file)
		if err != nil {
			return err
		}
		k.inherited[name] = copied
	}
	return nil
}

// Kept counts the descriptors the keeper holds.
func (k *Keeper) Kept() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.store)
}
