package main

import (
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConnectorForwardsTCPAfterDaemonHandshake(t *testing.T) {
	// Darwin limits Unix socket paths to 104 bytes; the test runner's default
	// temporary directory is longer than that on many developer machines.
	dir, err := os.MkdirTemp("/tmp", "gwdb-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socketPath := filepath.Join(dir, "database-tunnel.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)

	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		magic := make([]byte, len(handshakeMagic))
		if _, err := io.ReadFull(conn, magic); err != nil || string(magic) != handshakeMagic {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		var size [2]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			serverErr <- err
			return
		}
		binding := make([]byte, binary.BigEndian.Uint16(size[:]))
		if _, err := io.ReadFull(conn, binding); err != nil || string(binding) != "binding-123" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		payload := make([]byte, 4)
		if _, err := io.ReadFull(conn, payload); err != nil || string(payload) != "ping" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		_, err = conn.Write([]byte("pong"))
		serverErr <- err
	}()

	left, right := net.Pipe()
	defer left.Close()
	done := make(chan struct{})
	go func() {
		handle(right, socketPath, "binding-123")
		close(done)
	}()
	if _, err := left.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if err := left.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(left, response); err != nil {
		t.Fatal(err)
	}
	if string(response) != "pong" {
		t.Fatalf("unexpected response %q", response)
	}
	_ = left.Close()
	select {
	case err := <-serverErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("daemon server did not finish")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("connector did not finish")
	}
}
