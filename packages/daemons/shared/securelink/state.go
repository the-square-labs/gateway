package securelink

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type StateStore struct {
	path        string
	pendingPath string
	mu          sync.RWMutex
	current     *pb.SyncProxySecureLinksCommand
}

func NewStateStore(stateDir string) (*StateStore, error) {
	store := &StateStore{
		path:        filepath.Join(stateDir, "proxy-secure-links.json"),
		pendingPath: filepath.Join(stateDir, "proxy-secure-links.pending.json"),
		current:     &pb.SyncProxySecureLinksCommand{},
	}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err := protojson.Unmarshal(data, store.current); err != nil {
		return nil, fmt.Errorf("decode proxy secure-link state: %w", err)
	}
	return store, nil
}

func (s *StateStore) Save(command *pb.SyncProxySecureLinksCommand) error {
	return s.saveCommitted(command, false)
}

// Stage durably records an accepted command before live connector mutation.
// It deliberately does not replace the committed restart snapshot.
func (s *StateStore) Stage(command *pb.SyncProxySecureLinksCommand) error {
	if command == nil {
		return errors.New("proxy secure-link state is required")
	}
	data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(command)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeAtomic(s.pendingPath, data)
}

// Commit makes a fully applied command eligible for restart recovery and
// clears any interrupted-apply marker.
func (s *StateStore) Commit(command *pb.SyncProxySecureLinksCommand) error {
	return s.saveCommitted(command, true)
}

func (s *StateStore) saveCommitted(command *pb.SyncProxySecureLinksCommand, clearPending bool) error {
	if command == nil {
		return errors.New("proxy secure-link state is required")
	}
	data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(command)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeAtomic(s.path, data); err != nil {
		return err
	}
	s.current = proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	if clearPending {
		// Once the committed snapshot is durably renamed, the operation is
		// accepted. A stale pending marker is harmless and will be retried on
		// the next commit/startup; reporting failure here could make the caller
		// roll back even though restart recovery already points at this command.
		_ = os.Remove(s.pendingPath)
	}
	return nil
}

func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.pending-%d", path, os.Getpid())
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	err = directory.Sync()
	if closeErr := directory.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (s *StateStore) HasPending() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, err := os.Stat(s.pendingPath)
	return err == nil
}

func (s *StateStore) Pending() (*pb.SyncProxySecureLinksCommand, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, err := os.ReadFile(s.pendingPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	command := &pb.SyncProxySecureLinksCommand{}
	if err := protojson.Unmarshal(data, command); err != nil {
		return nil, true, fmt.Errorf("decode pending proxy secure-link state: %w", err)
	}
	return command, true, nil
}

func (s *StateStore) DiscardPending() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *StateStore) Get() *pb.SyncProxySecureLinksCommand {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return proto.Clone(s.current).(*pb.SyncProxySecureLinksCommand)
}

// SetSourceConfigManaged durably records whether restart recovery owns the
// generated Nginx proxy_pass for one source binding. It returns the previous
// value and whether the binding currently exists.
func (s *StateStore) SetSourceConfigManaged(linkID string, managed bool) (bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := proto.Clone(s.current).(*pb.SyncProxySecureLinksCommand)
	for _, binding := range next.Bindings {
		if binding.LinkId != linkID || binding.Role != "source" {
			continue
		}
		previous := binding.SourceConfigManaged
		if previous == managed {
			return previous, true, nil
		}
		binding.SourceConfigManaged = managed
		data, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(next)
		if err != nil {
			return previous, true, err
		}
		if err := writeAtomic(s.path, data); err != nil {
			return previous, true, err
		}
		s.current = next
		return previous, true, nil
	}
	return false, false, nil
}
