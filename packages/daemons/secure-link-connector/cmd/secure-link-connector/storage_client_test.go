package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const storageConnectorTestBindingID = "11111111-1111-4111-8111-111111111111"

func TestStorageConnectorConfigIsBounded(t *testing.T) {
	values := map[string]string{
		"GATEWAY_CONNECTOR_BINDING_ID": storageConnectorTestBindingID,
		"GATEWAY_CONNECTOR_SOCKET":     "/run/gateway/storage-relay.sock",
		"GATEWAY_CONNECTOR_LISTEN":     ":9000",
	}
	config, enabled, err := storageConnectorConfigFromEnv(func(name string) string { return values[name] })
	if err != nil || !enabled || config.BindingID != storageConnectorTestBindingID {
		t.Fatalf("storage config = %#v enabled=%v err=%v", config, enabled, err)
	}
	values["GATEWAY_CONNECTOR_LISTEN"] = "127.0.0.1:9000"
	if _, _, err := storageConnectorConfigFromEnv(func(name string) string { return values[name] }); err == nil {
		t.Fatal("expected non-fixed listener to be rejected")
	}
	values["GATEWAY_CONNECTOR_LISTEN"] = ":9000"
	values["GATEWAY_CONNECTOR_CA_PEM"] = "certificate"
	if _, _, err := storageConnectorConfigFromEnv(func(name string) string { return values[name] }); err == nil {
		t.Fatal("expected incomplete TLS environment to be rejected")
	}
}

func TestOpenStorageRelayUsesOnlyBindingIDRequest(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "slc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "relay.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	requestSeen := make(chan securelink.RelayRequest, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		var request securelink.RelayRequest
		if securelink.ReadJSON(connection, &request) != nil {
			return
		}
		requestSeen <- request
		if securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.ProtocolVersion}) != nil {
			return
		}
		buffer := make([]byte, 4)
		if _, err := connection.Read(buffer); err == nil {
			_, _ = connection.Write(buffer)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, err := openStorageRelay(ctx, storageConnectorConfig{BindingID: storageConnectorTestBindingID, SocketPath: socketPath})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case request := <-requestSeen:
		if request.OwnerKind != storageBindingOwnerKind || request.BindingID != storageConnectorTestBindingID {
			t.Fatalf("request = %#v", request)
		}
	case <-ctx.Done():
		t.Fatal("connector did not send relay request")
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 4)
	if _, err := connection.Read(response); err != nil || string(response) != "ping" {
		t.Fatalf("relay data = %q err=%v", response, err)
	}
}
