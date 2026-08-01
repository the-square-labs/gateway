package docker

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type shortWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (w *shortWriter) Write(data []byte) (int, error) {
	if len(data) > w.limit {
		data = data[:w.limit]
	}
	return w.buffer.Write(data)
}

func TestDatabaseTunnelHandshakeRoundTripWithShortWrites(t *testing.T) {
	bindingID := "33333333-3333-4333-8333-333333333333"
	writer := &shortWriter{limit: 3}
	if err := WriteDatabaseTunnelHandshake(writer, bindingID); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	data := writer.buffer.Bytes()
	if string(data[:len(DatabaseTunnelHandshakeMagic)]) != DatabaseTunnelHandshakeMagic {
		t.Fatalf("unexpected handshake magic: %q", data[:len(DatabaseTunnelHandshakeMagic)])
	}
	lengthOffset := len(DatabaseTunnelHandshakeMagic)
	if length := binary.BigEndian.Uint16(data[lengthOffset : lengthOffset+2]); int(length) != len(bindingID) {
		t.Fatalf("unexpected binding length: %d", length)
	}
	got, err := readDatabaseTunnelHandshake(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("read handshake: %v", err)
	}
	if got != bindingID {
		t.Fatalf("binding id mismatch: got %q want %q", got, bindingID)
	}
}

func TestDatabaseTunnelHandshakeRejectsInvalidInput(t *testing.T) {
	if err := WriteDatabaseTunnelHandshake(io.Discard, ""); err == nil {
		t.Fatal("expected empty binding id to be rejected")
	}
	if err := WriteDatabaseTunnelHandshake(io.Discard, strings.Repeat("a", databaseTunnelHandshakeLimit+1)); err == nil {
		t.Fatal("expected oversized binding id to be rejected")
	}
	invalidLength := append([]byte(DatabaseTunnelHandshakeMagic), 0, 0)
	if _, err := readDatabaseTunnelHandshake(bytes.NewReader(invalidLength)); err == nil {
		t.Fatal("expected zero binding length to be rejected")
	}
}

func TestDatabaseBindingRegistryPersistsAndRejectsRemap(t *testing.T) {
	dir := t.TempDir()
	bindingID := "33333333-3333-4333-8333-333333333333"
	databaseID := "44444444-4444-4444-8444-444444444444"
	registry, err := newDatabaseBindingRegistry(dir)
	if err != nil {
		t.Fatalf("create registry: %v", err)
	}
	if err := registry.prepare(bindingID, databaseID); err != nil {
		t.Fatalf("prepare binding: %v", err)
	}
	if err := registry.prepare(bindingID, "55555555-5555-4555-8555-555555555555"); err == nil {
		t.Fatal("expected remap to another database to be rejected")
	}

	reloaded, err := newDatabaseBindingRegistry(dir)
	if err != nil {
		t.Fatalf("reload registry: %v", err)
	}
	if got, ok := reloaded.resolve(bindingID); !ok || got != databaseID {
		t.Fatalf("persisted mapping mismatch: got %q, ok=%v", got, ok)
	}
	info, err := os.Stat(filepath.Join(dir, "database-bindings.json"))
	if err != nil {
		t.Fatalf("stat registry: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("registry permissions = %o, want 600", info.Mode().Perm())
	}
	if err := reloaded.remove(bindingID, "55555555-5555-4555-8555-555555555555"); err == nil {
		t.Fatal("expected removal with a mismatched database id to be rejected")
	}
	if err := reloaded.remove(bindingID, databaseID); err != nil {
		t.Fatalf("remove binding: %v", err)
	}
	if _, ok := reloaded.resolve(bindingID); ok {
		t.Fatal("binding remains after removal")
	}
}

func TestManagedDatabaseEnginePortsAreFixed(t *testing.T) {
	tests := map[string]string{"postgres": "5432", "redis": "6379", "clickhouse": "8123"}
	for engine, expected := range tests {
		port, err := managedDatabaseEnginePort(engine)
		if err != nil {
			t.Fatalf("resolve %s port: %v", engine, err)
		}
		if port != expected {
			t.Fatalf("%s port = %s, want %s", engine, port, expected)
		}
	}
	if _, err := managedDatabaseEnginePort("mysql"); err == nil {
		t.Fatal("expected unsupported engine to be rejected")
	}
}

func TestDatabaseTunnelSessionCapsReleaseAfterClose(t *testing.T) {
	transport := &databaseTunnelTransport{sessions: make(map[string]*databaseTunnelSession)}
	var peers []net.Conn
	for i := 0; i < databaseTunnelMaxSessionsPerBinding; i++ {
		left, right := net.Pipe()
		peers = append(peers, right)
		session, err := transport.addSession(fmt.Sprintf("tunnel-%d", i), "binding-a", left)
		if err != nil || session == nil {
			t.Fatalf("admit session %d: %v", i, err)
		}
	}
	overflow, overflowPeer := net.Pipe()
	defer overflowPeer.Close()
	if _, err := transport.addSession("overflow", "binding-a", overflow); err == nil {
		t.Fatal("expected per-binding session cap")
	}
	_ = overflow.Close()

	transport.finishMatching("tunnel-0", "binding-a", nil)
	retry, retryPeer := net.Pipe()
	peers = append(peers, retryPeer)
	if _, err := transport.addSession("retry", "binding-a", retry); err != nil {
		t.Fatalf("admit after close: %v", err)
	}
	transport.shutdown()
	for _, peer := range peers {
		_ = peer.Close()
	}
}
