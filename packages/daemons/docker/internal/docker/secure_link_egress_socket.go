package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/netaccept"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

// The egress socket (C4): the shared connector opens one stream here for every connection a workload makes to an
// egress listener. The request names a link (owner kind and id) and nothing else; the daemon finds the link's
// signed connect grant and carries the stream to the link's target: on this node directly when the target's
// endpoint is here, else through a relay.
const (
	egressSocketName = "egress.sock"
	// egressDatabaseSessions bounds the database link sessions of the node's egress together, as the host listeners
	// did per binding and node (D9).
	egressDatabaseSessions    = 128
	egressRequestReadDeadline = 5 * time.Second
)

func secureLinkEgressSocketPath(stateDir string) string {
	return filepath.Join(stateDir, "secure-link-connector", egressSocketName)
}

// startSecureLinkEgressSocket listens on the egress socket in the connector's control directory, with the owner and
// mode of the other connector sockets (storageConnectorSocketFits): uid 65532 and 0600 under a root daemon, the
// daemon's user and group with 0660 without root (the connector holds that group). The socket the previous process
// handed over is adopted, so a daemon restart refuses no link connection.
func (p *DockerPlugin) startSecureLinkEgressSocket() error {
	path := secureLinkEgressSocketPath(p.cfg.StateDir)
	if p.egressDatabaseSlots == nil {
		p.egressDatabaseSlots = make(chan struct{}, egressDatabaseSessions)
	}
	if listener, keptName := adoptKeptUnixListener(path, storageConnectorSocketFits); listener != nil {
		p.secureLinkEgressKept.set(listener, keptName)
		go netaccept.Serve(listener, nil, p.handleSecureLinkEgress)
		return nil
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace a non-socket secure-link egress path")
		}
		// A socket of the previous process or of a daemon of the other mode.
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove stale secure-link egress socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect secure-link egress socket: %w", err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listen on the secure-link egress socket: %w", err)
	}
	if err := setConnectorSocketOwner(path); err != nil {
		_ = listener.Close()
		return fmt.Errorf("secure-link egress socket: %w", err)
	}
	p.secureLinkEgressKept.set(listener, keepUnixListener(listener, path))
	go netaccept.Serve(listener, nil, p.handleSecureLinkEgress)
	return nil
}

// setConnectorSocketOwner gives a daemon socket the connectors connect to its owner and mode.
func setConnectorSocketOwner(path string) error {
	if runsWithoutRoot() {
		return os.Chmod(path, 0o660)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	return os.Chown(path, connectorUID, connectorUID)
}

func (p *DockerPlugin) handleSecureLinkEgress(connection net.Conn) {
	defer connection.Close()
	refuse := func(message string) {
		_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: message})
	}
	_ = connection.SetReadDeadline(time.Now().Add(egressRequestReadDeadline))
	var request securelink.RelayRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		refuse(err.Error())
		return
	}
	_ = connection.SetReadDeadline(time.Time{})
	if request.Version != securelink.RelayProtocolVersion || egressNetworkPattern(request.OwnerKind) == nil || !proxySecureLinkIDPattern.MatchString(request.BindingID) {
		refuse("invalid secure-link egress request")
		return
	}
	link := linkKey{kind: request.OwnerKind, id: request.BindingID}
	assignment := p.relayGrants.lookup("connect", request.OwnerKind, request.BindingID)
	if assignment == nil || assignment.GetSecureLinkEgress() == nil {
		p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedGrantUnavailable)
		refuse("link relay route is unavailable")
		return
	}
	if link.kind == linkKindManagedDatabaseBinding {
		select {
		case p.egressDatabaseSlots <- struct{}{}:
			defer func() { <-p.egressDatabaseSlots }()
		default:
			p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedNodeLimit, "limit", egressDatabaseSessions)
			refuse(fmt.Sprintf("link session capacity reached: the node carries its %d concurrent database link connections", egressDatabaseSessions))
			return
		}
	}
	// Every connection of the link passes this socket, whichever connector or relay carries it: the link is held at
	// its capacity here.
	limit := relayGrantSessionLimit(assignment, managedLinkDefaultSessions)
	if !p.linkConnections.acquire(link, int(limit)) {
		p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedLinkLimit, "limit", limit)
		refuse(fmt.Sprintf("link session capacity reached: the link carries its %d concurrent connections", limit))
		return
	}
	defer p.linkConnections.release(link)
	if p.relayGrants.lookup("endpoint", request.OwnerKind, request.BindingID) != nil {
		p.carryLocalEgress(connection, link, refuse)
		return
	}
	tunnel, err := p.openRelaySource(assignment)
	if err != nil {
		reason := relayRefusalReason(err)
		p.linkRejections.rejected(p.logger, link.kind, link.id, reason, "error", relayRefusalMessage(err))
		refuse("link relay refused the connection: " + relayRefusalMessage(err))
		return
	}
	if err := securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion}); err != nil {
		tunnel.close()
		return
	}
	// Tracked so a restart lets the request in flight finish (link_listener_handover.go).
	flow, done := p.linkFlows.track(connection)
	defer done()
	tunnel.bridge(p.linkTraffic.carry(link, flow))
}

// carryLocalEgress serves a link whose target endpoint is on this node without a relay hop: a container link's
// stream goes to the target's ingress binding on the same connector. A managed database or storage endpoint is never
// on a node that serves egress (they live on storage nodes, which have no connector).
func (p *DockerPlugin) carryLocalEgress(connection net.Conn, link linkKey, refuse func(string)) {
	if link.kind != containerLinkOwnerKind || p.secureLinks == nil {
		refuse("link target endpoint is not served on this node")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	target, err := p.secureLinks.dial(ctx, link.id)
	cancel()
	if err != nil {
		p.linkRejections.rejected(p.logger, link.kind, link.id, linkRejectedRelayUnavailable, "error", err.Error())
		refuse("link target is unavailable: " + err.Error())
		return
	}
	defer target.Close()
	if err := securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion}); err != nil {
		return
	}
	flow, done := p.linkFlows.track(connection)
	defer done()
	tracked := newDrainConn(target)
	defer p.proxyTunnels.add(tracked, func() { _ = target.Close() })()
	pipeConnections(p.linkTraffic.carry(link, flow), tracked)
}

// pipeConnections copies both ways until both directions ended, passing a half-close on.
func pipeConnections(left, right net.Conn) {
	done := make(chan struct{}, 2)
	copyOne := func(destination, source net.Conn) {
		_, err := io.Copy(destination, source)
		if closer, ok := destination.(interface{ CloseWrite() error }); ok && err == nil {
			_ = closer.CloseWrite()
		} else {
			_ = destination.Close()
			_ = source.Close()
		}
		done <- struct{}{}
	}
	go copyOne(left, right)
	go copyOne(right, left)
	<-done
	<-done
}
