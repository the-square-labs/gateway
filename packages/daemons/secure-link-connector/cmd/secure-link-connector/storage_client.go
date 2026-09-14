package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const (
	storageConnectorListenAddress = ":9000"
	storageBindingOwnerKind       = "managed_storage_binding"
)

var storageConnectorBindingIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type storageConnectorConfig struct {
	BindingID  string
	SocketPath string
	Listen     string
	CAPEM      string
	ServerName string
}

func storageConnectorConfigFromEnv(getenv func(string) string) (storageConnectorConfig, bool, error) {
	bindingID := strings.TrimSpace(getenv("GATEWAY_CONNECTOR_BINDING_ID"))
	if bindingID == "" {
		return storageConnectorConfig{}, false, nil
	}
	config := storageConnectorConfig{
		BindingID:  bindingID,
		SocketPath: strings.TrimSpace(getenv("GATEWAY_CONNECTOR_SOCKET")),
		Listen:     strings.TrimSpace(getenv("GATEWAY_CONNECTOR_LISTEN")),
		CAPEM:      strings.TrimSpace(getenv("GATEWAY_CONNECTOR_CA_PEM")),
		ServerName: strings.TrimSpace(getenv("GATEWAY_CONNECTOR_SERVER_NAME")),
	}
	if !storageConnectorBindingIDPattern.MatchString(config.BindingID) {
		return config, true, errors.New("GATEWAY_CONNECTOR_BINDING_ID must be a UUID")
	}
	if config.SocketPath == "" || !filepath.IsAbs(config.SocketPath) {
		return config, true, errors.New("GATEWAY_CONNECTOR_SOCKET must be an absolute path")
	}
	if config.Listen != storageConnectorListenAddress {
		return config, true, fmt.Errorf("GATEWAY_CONNECTOR_LISTEN must be %s", storageConnectorListenAddress)
	}
	if (config.CAPEM == "") != (config.ServerName == "") {
		return config, true, errors.New("GATEWAY_CONNECTOR_CA_PEM and GATEWAY_CONNECTOR_SERVER_NAME must be set together")
	}
	return config, true, nil
}

func storageConnectorTLSConfig(config storageConnectorConfig) (*tls.Config, error) {
	if config.CAPEM == "" {
		return nil, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(config.CAPEM)) {
		return nil, errors.New("GATEWAY_CONNECTOR_CA_PEM is not a valid certificate")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: config.ServerName}, nil
}

func runStorageConnector(ctx context.Context, config storageConnectorConfig) error {
	tlsConfig, err := storageConnectorTLSConfig(config)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return fmt.Errorf("listen storage connector: %w", err)
	}
	defer listener.Close()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("accept storage connector connection: %w", err)
		}
		go proxyStorageConnectorConnection(ctx, connection, config, tlsConfig)
	}
}

func proxyStorageConnectorConnection(ctx context.Context, local net.Conn, config storageConnectorConfig, tlsConfig *tls.Config) {
	defer local.Close()
	remote, err := openStorageRelay(ctx, config)
	if err != nil {
		return
	}
	defer remote.Close()
	if tlsConfig != nil {
		tlsRemote := tls.Client(remote, tlsConfig)
		handshakeCtx, cancel := context.WithTimeout(ctx, targetDialTimeout)
		err = tlsRemote.HandshakeContext(handshakeCtx)
		cancel()
		if err != nil {
			return
		}
		remote = tlsRemote
	}
	bridge(local, remote)
}

func openStorageRelay(ctx context.Context, config storageConnectorConfig) (net.Conn, error) {
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", config.SocketPath)
	if err != nil {
		return nil, fmt.Errorf("connect storage relay socket: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	} else {
		_ = connection.SetDeadline(time.Now().Add(targetDialTimeout))
	}
	request := securelink.RelayRequest{Version: securelink.ProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: config.BindingID}
	if err := securelink.WriteJSON(connection, request); err != nil {
		_ = connection.Close()
		return nil, err
	}
	var response securelink.RelayResponse
	if err := securelink.ReadJSON(connection, &response); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if response.Version != securelink.ProtocolVersion {
		_ = connection.Close()
		return nil, errors.New("unsupported storage relay protocol version")
	}
	if response.Error != "" {
		_ = connection.Close()
		return nil, errors.New(response.Error)
	}
	_ = connection.SetDeadline(time.Time{})
	return connection, nil
}

func storageConnectorEnvironment() func(string) string { return os.Getenv }
