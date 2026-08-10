package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

func main() {
	socketPath := strings.TrimSpace(os.Getenv("GATEWAY_SECURE_LINK_SOCKET"))
	if socketPath == "" || !filepath.IsAbs(socketPath) {
		log.Fatal("GATEWAY_SECURE_LINK_SOCKET must be an absolute path")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
		log.Fatalf("create control directory: %v", err)
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatalf("remove stale control socket: %v", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("listen on control socket: %v", err)
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		listener.Close()
		log.Fatalf("set control socket permissions: %v", err)
	}

	manager := newBindingManager(0, 0)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		listener.Close()
		manager.close()
	}()

	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("accept control connection: %v", err)
			continue
		}
		go handleControlConnection(connection, manager)
	}
}

func handleControlConnection(connection net.Conn, manager *bindingManager) {
	defer connection.Close()
	var request securelink.SyncRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		_ = securelink.WriteJSON(connection, securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: err.Error()})
		return
	}
	if request.Version != securelink.ProtocolVersion {
		_ = securelink.WriteJSON(connection, securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: "unsupported protocol version"})
		return
	}
	statuses, err := manager.sync(request.Bindings)
	response := securelink.SyncResponse{Version: securelink.ProtocolVersion, Bindings: statuses}
	if err != nil {
		response.Bindings = nil
		response.Error = err.Error()
	}
	_ = securelink.WriteJSON(connection, response)
}
