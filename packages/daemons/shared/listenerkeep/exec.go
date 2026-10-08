package listenerkeep

import (
	"errors"
	"log/slog"
	"net"
	"os"
	"syscall"
	"time"
)

// Export names the descriptors of a keeper that moves into the launcher image
// its launcher execs in place: descriptor numbers survive the exec once their
// close-on-exec flag is cleared (the launcher clears it on Descriptors).
type Export struct {
	// Channel is the launcher's end of the channel; ChildEnd the end every
	// daemon process is handed.
	Channel  int              `json:"channel"`
	ChildEnd int              `json:"childEnd"`
	Kept     []keptDescriptor `json:"kept,omitempty"`
}

// Descriptors lists every descriptor of the export.
func (e Export) Descriptors() []int {
	descriptors := []int{e.Channel, e.ChildEnd}
	for _, kept := range e.Kept {
		descriptors = append(descriptors, kept.FD)
	}
	return descriptors
}

// PrepareExec stops the keeper for the launcher's exec in place and describes
// it. Messages a daemon sends from now on wait in the channel for the next
// image. resume restarts the keeper when the exec did not happen.
func (s *Store) PrepareExec() (Export, func(), error) {
	s.mu.Lock()
	s.frozen = true
	s.mu.Unlock()
	_ = s.channel.SetReadDeadline(time.Unix(1, 0))
	<-s.receiving
	resume := func() {
		s.mu.Lock()
		s.frozen = false
		s.mu.Unlock()
		_ = s.channel.SetReadDeadline(time.Time{})
		s.startReceiving()
	}
	export := Export{}
	var err error
	if export.Channel, err = rawDescriptor(s.channel); err != nil {
		resume()
		return Export{}, nil, err
	}
	if export.ChildEnd, err = rawDescriptor(s.childEnd); err != nil {
		resume()
		return Export{}, nil, err
	}
	s.mu.Lock()
	for name, file := range s.files {
		fd, fdErr := rawDescriptor(file)
		if fdErr != nil {
			s.mu.Unlock()
			resume()
			return Export{}, nil, fdErr
		}
		export.Kept = append(export.Kept, keptDescriptor{Name: name, FD: fd})
	}
	s.mu.Unlock()
	return export, resume, nil
}

// AdoptStore rebuilds the keeper the previous launcher image exported before
// it execed into this one, and marks its descriptors close-on-exec again.
func AdoptStore(export Export, logger *slog.Logger) (*Store, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if export.Channel < 3 || export.ChildEnd < 3 || export.Channel == export.ChildEnd {
		return nil, errors.New("listener keeper export is invalid")
	}
	for _, fd := range export.Descriptors() {
		syscall.CloseOnExec(fd)
	}
	channelFile := os.NewFile(uintptr(export.Channel), "listener-keep-launcher")
	connection, err := net.FileConn(channelFile)
	_ = channelFile.Close()
	if err != nil {
		return nil, err
	}
	channel, ok := connection.(*net.UnixConn)
	if !ok {
		_ = connection.Close()
		return nil, errors.New("listener keeper channel is not a unix socket")
	}
	childEnd := os.NewFile(uintptr(export.ChildEnd), "listener-keep-daemon")
	syncConnection, err := net.FileConn(childEnd)
	if err != nil {
		_ = channel.Close()
		_ = childEnd.Close()
		return nil, err
	}
	syncEnd, ok := syncConnection.(*net.UnixConn)
	if !ok {
		_ = syncConnection.Close()
		_ = channel.Close()
		_ = childEnd.Close()
		return nil, errors.New("listener keeper channel is not a unix socket")
	}
	files := make(map[string]*os.File, len(export.Kept))
	for _, kept := range export.Kept {
		if kept.FD < 3 || kept.Name == "" {
			continue
		}
		files[kept.Name] = os.NewFile(uintptr(kept.FD), kept.Name)
	}
	store := &Store{
		files:    files,
		notify:   dialNotifySocket(),
		logger:   logger,
		channel:  channel,
		childEnd: childEnd,
		syncEnd:  syncEnd,
		syncWait: map[uint64]chan struct{}{},
		done:     make(chan struct{}),
	}
	store.startReceiving()
	return store, nil
}

// rawDescriptor returns the descriptor number behind file without File.Fd,
// which would switch the socket every copy shares to blocking mode.
func rawDescriptor(file syscall.Conn) (int, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return -1, err
	}
	fd := -1
	if err := raw.Control(func(descriptor uintptr) { fd = int(descriptor) }); err != nil {
		return -1, err
	}
	return fd, nil
}
