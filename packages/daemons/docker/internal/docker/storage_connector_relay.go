package docker

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const (
	storageConnectorSocketDirectory = "storage-connector"
	storageConnectorSocketName      = "storage-relay.sock"
	storageConnectorSocketPath      = "/run/gateway/storage-relay.sock"
	storageBindingOwnerKind         = "managed_storage_binding"
)

func storageConnectorRelayDirectory(stateDir string) string {
	return filepath.Join(stateDir, storageConnectorSocketDirectory)
}

func storageConnectorRelaySocketPath(stateDir string) string {
	return filepath.Join(storageConnectorRelayDirectory(stateDir), storageConnectorSocketName)
}

// startStorageConnectorRelay accepts one typed request per connection from an
// owned storage connector. The request identifies a relay grant by binding ID;
// it cannot select a host, port, Docker bind, or arbitrary route target.
func (p *DockerPlugin) startStorageConnectorRelay() error {
	directory := storageConnectorRelayDirectory(p.cfg.StateDir)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create storage connector relay directory: %w", err)
	}
	if err := os.Chown(directory, 65532, 65532); err != nil {
		return fmt.Errorf("set storage connector relay directory ownership: %w", err)
	}
	path := filepath.Join(directory, storageConnectorSocketName)
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace non-socket storage connector relay path")
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove stale storage connector relay socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect storage connector relay socket: %w", err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listen storage connector relay socket: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("set storage connector relay socket permissions: %w", err)
	}
	if err := os.Chown(path, 65532, 65532); err != nil {
		_ = listener.Close()
		return fmt.Errorf("set storage connector relay socket ownership: %w", err)
	}
	p.storageConnectorListener = listener
	p.storageConnectorSocket = path
	go p.serveStorageConnectorRelay(listener)
	return nil
}

func (p *DockerPlugin) serveStorageConnectorRelay(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go p.handleStorageConnectorRelay(connection)
	}
}

func (p *DockerPlugin) handleStorageConnectorRelay(connection net.Conn) {
	defer connection.Close()
	var request securelink.RelayRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.ProtocolVersion, Error: err.Error()})
		return
	}
	if request.Version != securelink.ProtocolVersion || request.OwnerKind != storageBindingOwnerKind || !proxySecureLinkIDPattern.MatchString(request.BindingID) {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.ProtocolVersion, Error: "invalid storage connector relay request"})
		return
	}
	assignment := findRelayAssignment(p.relayGrants.get(), "connect", storageBindingOwnerKind, request.BindingID)
	if assignment == nil || (assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0) {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.ProtocolVersion, Error: "storage binding relay route is unavailable"})
		return
	}
	if err := securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.ProtocolVersion}); err != nil {
		return
	}
	p.openStorageConnectorAssignment(connection, assignment)
}

func (p *DockerPlugin) openStorageConnectorAssignment(connection net.Conn, assignment *pb.RelayGrantAssignment) bool {
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.GetGrant()}}
	}
	for _, candidate := range p.orderRelayCandidates(candidates) {
		router := p.relayRouter(candidate.GetRelayInstanceId())
		if router != nil && router.openSourceTunnel(connection, candidate.GetGrant()) {
			return true
		}
	}
	return false
}

// validStorageConnectorInternalWorkload is used by the internal-workload
// dispatcher before it creates the dedicated managed-storage connector.
func validStorageConnectorInternalWorkload(env []string, binds []string, socketHostPath string) bool {
	if len(binds) != 1 || binds[0] != socketHostPath+":/run/gateway:ro" {
		return false
	}
	seenBinding, seenSocket, seenListen := false, false, false
	seenCA, seenServerName := false, false
	for _, value := range env {
		switch {
		case strings.HasPrefix(value, "GATEWAY_CONNECTOR_BINDING_ID="):
			if seenBinding || !proxySecureLinkIDPattern.MatchString(strings.TrimPrefix(value, "GATEWAY_CONNECTOR_BINDING_ID=")) {
				return false
			}
			seenBinding = true
		case value == "GATEWAY_CONNECTOR_SOCKET="+storageConnectorSocketPath:
			if seenSocket {
				return false
			}
			seenSocket = true
		case value == "GATEWAY_CONNECTOR_LISTEN=:9000":
			if seenListen {
				return false
			}
			seenListen = true
		case strings.HasPrefix(value, "GATEWAY_CONNECTOR_CA_PEM=") && strings.TrimPrefix(value, "GATEWAY_CONNECTOR_CA_PEM=") != "":
			if seenCA {
				return false
			}
			seenCA = true
		case strings.HasPrefix(value, "GATEWAY_CONNECTOR_SERVER_NAME=") && strings.TrimPrefix(value, "GATEWAY_CONNECTOR_SERVER_NAME=") != "":
			if seenServerName {
				return false
			}
			seenServerName = true
		default:
			return false
		}
	}
	return seenBinding && seenSocket && seenListen && seenCA == seenServerName
}
