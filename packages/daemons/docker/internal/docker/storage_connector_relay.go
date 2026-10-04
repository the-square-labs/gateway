package docker

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/wiolett-industries/gateway/daemon-shared/netaccept"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const (
	storageConnectorSocketDirectory = "storage-connector"
	storageConnectorSocketName      = "storage-relay.sock"
	storageConnectorSocketPath      = "/run/gateway/storage-relay.sock"
	storageBindingOwnerKind         = "managed_storage_binding"
	// managedStorageLinkCapability: the node hosts managed storage link connectors (this socket). Availability
	// projects a workload's storage links only to Docker nodes that advertise it.
	managedStorageLinkCapability = "managed_storage_link_v1"
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
	if runsWithoutRoot() {
		// The connectors reach the socket through the daemon's group (connectorGroupAdd).
		if err := claimConnectorDirectory(directory, 0o750); err != nil {
			return fmt.Errorf("storage connector relay directory: %w", err)
		}
	} else {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return fmt.Errorf("create storage connector relay directory: %w", err)
		}
		if err := os.Chown(directory, 65532, 65532); err != nil {
			return fmt.Errorf("set storage connector relay directory ownership: %w", err)
		}
		// A directory a non-root daemon left behind is readable by that daemon's group.
		if err := os.Chmod(directory, 0o700); err != nil {
			return fmt.Errorf("set storage connector relay directory permissions: %w", err)
		}
	}
	// The storage connectors of the other mode keep their access through a switch of the daemon's user.
	if err := grantConnectorAccess(directory, 7); err != nil && p.logger != nil {
		p.logger.Warn("storage connector relay directory keeps its connectors' access only by its mode", "error", err)
	}
	path := filepath.Join(directory, storageConnectorSocketName)
	// The socket the previous process handed over keeps the connections the connectors made meanwhile; one of the
	// previous mode's is served as well until its connectors are recreated (link_socket_mode_handover.go).
	kept, keptName, previous := adoptKeptUnixListeners(path, storageConnectorSocketFits)
	p.storageConnectorPrevious.serve(previous, p.handleStorageConnectorRelay)
	if kept != nil {
		p.storageConnectorListener = kept
		p.storageConnectorSocket = path
		p.storageConnectorKept.set(kept, keptName)
		go p.serveStorageConnectorRelay(kept)
		return nil
	}
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
	if runsWithoutRoot() {
		if err := os.Chmod(path, 0o660); err != nil {
			_ = listener.Close()
			return fmt.Errorf("set storage connector relay socket permissions: %w", err)
		}
	} else {
		if err := os.Chmod(path, 0o600); err != nil {
			_ = listener.Close()
			return fmt.Errorf("set storage connector relay socket permissions: %w", err)
		}
		if err := os.Chown(path, 65532, 65532); err != nil {
			_ = listener.Close()
			return fmt.Errorf("set storage connector relay socket ownership: %w", err)
		}
	}
	if err := grantConnectorAccess(path, 6); err != nil && p.logger != nil {
		p.logger.Warn("storage connector relay socket keeps its connectors' access only by its mode", "error", err)
	}
	p.storageConnectorListener = listener
	p.storageConnectorSocket = path
	p.storageConnectorKept.set(listener, keepUnixListener(listener, path))
	go p.serveStorageConnectorRelay(listener)
	return nil
}

// storageConnectorSocketFits reports whether the relay socket file has the owner and mode this daemon gives it: its
// own user and group with 0660 without root (the connectors reach it through that group), uid 65532 with 0600 as root.
func storageConnectorSocketFits(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	if runsWithoutRoot() {
		return int(stat.Uid) == daemonEUID() && int(stat.Gid) == daemonEGID() && info.Mode().Perm() == 0o660
	}
	// The group bits show the mask of the connectors' ACL entry (grantConnectorAccess): 0600 or 0660.
	return stat.Uid == connectorUID && info.Mode().Perm()&0o707 == 0o600
}

func (p *DockerPlugin) serveStorageConnectorRelay(listener net.Listener) {
	netaccept.Serve(listener, nil, p.handleStorageConnectorRelay)
}

func (p *DockerPlugin) handleStorageConnectorRelay(connection net.Conn) {
	defer connection.Close()
	var request securelink.RelayRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: err.Error()})
		return
	}
	if request.Version != securelink.RelayProtocolVersion || request.OwnerKind != storageBindingOwnerKind || !proxySecureLinkIDPattern.MatchString(request.BindingID) {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: "invalid storage connector relay request"})
		return
	}
	assignment := p.relayGrants.lookup("connect", storageBindingOwnerKind, request.BindingID)
	if assignment == nil || (assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0) {
		p.linkRejections.rejected(p.logger, linkKindManagedStorageBinding, request.BindingID, linkRejectedGrantUnavailable)
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: "storage binding relay route is unavailable"})
		return
	}
	// Every connection of the link passes this socket, whichever connector of the node and relay of the pool carries
	// it: the link is held at its capacity here.
	link := linkKey{kind: linkKindManagedStorageBinding, id: request.BindingID}
	limit := relayGrantSessionLimit(assignment, managedLinkDefaultSessions)
	if !p.linkConnections.acquire(link, int(limit)) {
		p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedLinkLimit, "limit", limit)
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion,
			Error: fmt.Sprintf("storage link session capacity reached: the link carries its %d concurrent connections", limit)})
		return
	}
	defer p.linkConnections.release(link)
	// The connector hears "ready" only once a relay admitted the tunnel, so a refusal (the link's session capacity)
	// reaches it as an error it logs, instead of an accepted connection that closes without a reason.
	tunnel, err := p.openRelaySource(assignment)
	if err != nil {
		reason := relayRefusalReason(err)
		p.linkRejections.rejected(p.logger, linkKindManagedStorageBinding, request.BindingID, reason, "error", relayRefusalMessage(err))
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: storageConnectorRelayRefusal(reason, err)})
		return
	}
	if err := securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion}); err != nil {
		tunnel.close()
		return
	}
	// Tracked so a restart lets the request in flight finish (link_listener_handover.go).
	flow, done := p.linkFlows.track(connection)
	defer done()
	defer p.linkTraffic.completed(link)
	tunnel.bridge(p.linkTraffic.carry(link, flow))
}

func storageConnectorRelayRefusal(reason string, err error) string {
	switch reason {
	case linkRejectedRelayCapacity:
		return "storage link session capacity reached: " + relayRefusalMessage(err)
	case linkRejectedRelayUnavailable:
		return "storage link relay is unavailable: " + relayRefusalMessage(err)
	default:
		return "storage link relay refused the connection: " + relayRefusalMessage(err)
	}
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
