package docker

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf8"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	databaseTunnelCapability     = "database_tunnel_v1"
	databaseTunnelMaxChunkBytes  = 1024 * 1024
	databaseTunnelQueueDepth     = 4
	databaseTunnelHandshakeLimit = 128

	// DatabaseTunnelSocketFilename is the single daemon-owned socket mounted
	// only into first-party connector sidecars on a general Docker node.
	DatabaseTunnelSocketFilename = "database-tunnel.sock"
	// DatabaseTunnelHandshakeMagic starts every connector-sidecar handshake.
	DatabaseTunnelHandshakeMagic = "GWDB1\n"
)

type databaseBindingRegistry struct {
	mu       sync.RWMutex
	path     string
	bindings map[string]string
}

func newDatabaseBindingRegistry(stateDir string) (*databaseBindingRegistry, error) {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, fmt.Errorf("create daemon state directory: %w", err)
	}
	r := &databaseBindingRegistry{
		path:     filepath.Join(stateDir, "database-bindings.json"),
		bindings: make(map[string]string),
	}
	data, err := os.ReadFile(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read database binding registry: %w", err)
	}
	if err := json.Unmarshal(data, &r.bindings); err != nil {
		return nil, fmt.Errorf("parse database binding registry: %w", err)
	}
	for bindingID, databaseID := range r.bindings {
		if !managedDatabaseIDPattern.MatchString(bindingID) || !managedDatabaseIDPattern.MatchString(databaseID) {
			return nil, errors.New("database binding registry contains an invalid identifier")
		}
	}
	return r, nil
}

func (r *databaseBindingRegistry) resolve(bindingID string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	databaseID, ok := r.bindings[bindingID]
	return databaseID, ok
}

func (r *databaseBindingRegistry) prepare(bindingID, databaseID string) error {
	if !managedDatabaseIDPattern.MatchString(bindingID) || !managedDatabaseIDPattern.MatchString(databaseID) {
		return errors.New("invalid database binding identifier")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if current, ok := r.bindings[bindingID]; ok && current != databaseID {
		return errors.New("database binding is already mapped to another managed database")
	}
	previous, existed := r.bindings[bindingID]
	r.bindings[bindingID] = databaseID
	if err := r.saveLocked(); err != nil {
		if existed {
			r.bindings[bindingID] = previous
		} else {
			delete(r.bindings, bindingID)
		}
		return err
	}
	return nil
}

func (r *databaseBindingRegistry) remove(bindingID, databaseID string) error {
	if !managedDatabaseIDPattern.MatchString(bindingID) {
		return errors.New("invalid database binding identifier")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.bindings[bindingID]
	if !ok {
		return nil
	}
	if databaseID != "" && current != databaseID {
		return errors.New("database binding does not match the managed database")
	}
	delete(r.bindings, bindingID)
	if err := r.saveLocked(); err != nil {
		r.bindings[bindingID] = current
		return err
	}
	return nil
}

func (r *databaseBindingRegistry) saveLocked() error {
	data, err := json.Marshal(r.bindings)
	if err != nil {
		return fmt.Errorf("encode database binding registry: %w", err)
	}
	tempPath := r.path + ".tmp"
	if err := os.WriteFile(tempPath, data, 0600); err != nil {
		return fmt.Errorf("write database binding registry: %w", err)
	}
	if err := os.Rename(tempPath, r.path); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("replace database binding registry: %w", err)
	}
	return nil
}

// WriteDatabaseTunnelHandshake emits the bounded sidecar-to-daemon handshake.
// All bytes after this function returns are raw database protocol bytes.
func WriteDatabaseTunnelHandshake(w io.Writer, bindingID string) error {
	if len(bindingID) == 0 || len(bindingID) > databaseTunnelHandshakeLimit || !utf8.ValidString(bindingID) {
		return errors.New("invalid database binding id")
	}
	if err := writeDatabaseTunnelBytes(w, []byte(DatabaseTunnelHandshakeMagic)); err != nil {
		return err
	}
	var size [2]byte
	binary.BigEndian.PutUint16(size[:], uint16(len(bindingID)))
	if err := writeDatabaseTunnelBytes(w, size[:]); err != nil {
		return err
	}
	return writeDatabaseTunnelBytes(w, []byte(bindingID))
}

func writeDatabaseTunnelBytes(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func readDatabaseTunnelHandshake(r io.Reader) (string, error) {
	magic := make([]byte, len(DatabaseTunnelHandshakeMagic))
	if _, err := io.ReadFull(r, magic); err != nil {
		return "", err
	}
	if string(magic) != DatabaseTunnelHandshakeMagic {
		return "", errors.New("invalid database tunnel handshake")
	}
	var size [2]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return "", err
	}
	length := int(binary.BigEndian.Uint16(size[:]))
	if length < 1 || length > databaseTunnelHandshakeLimit {
		return "", errors.New("invalid database binding id length")
	}
	binding := make([]byte, length)
	if _, err := io.ReadFull(r, binding); err != nil {
		return "", err
	}
	if !utf8.Valid(binding) {
		return "", errors.New("database binding id is not valid UTF-8")
	}
	return string(binding), nil
}

func (p *DockerPlugin) handleDatabaseBindingCommand(cmd *pb.DockerDatabaseBindingCommand, result *pb.CommandResult) {
	if p.databaseBindings == nil {
		result.Success = false
		result.Error = "database bindings are available only on general Docker nodes"
		return
	}
	var err error
	switch cmd.GetAction() {
	case "prepare":
		err = p.databaseBindings.prepare(cmd.GetBindingId(), cmd.GetManagedDatabaseId())
		if err == nil {
			detail, _ := json.Marshal(map[string]string{
				"socketPath": filepath.Join(p.cfg.StateDir, DatabaseTunnelSocketFilename),
			})
			result.Detail = string(detail)
		}
	case "remove":
		err = p.databaseBindings.remove(cmd.GetBindingId(), cmd.GetManagedDatabaseId())
		if err == nil {
			p.databaseTunnelMu.Lock()
			transport := p.databaseTunnel
			p.databaseTunnelMu.Unlock()
			if transport != nil {
				transport.closeBinding(cmd.GetBindingId())
			}
		}
	default:
		err = errors.New("unsupported database binding action")
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
	}
}
