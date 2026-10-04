package securelink

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

const (
	// ProtocolVersion is the connector control protocol: 2 adds egress
	// listeners. A connector still answers a version 1 request (ingress only)
	// with version 1, so a daemon rolled back to a v1 release keeps working.
	ProtocolVersion = 2
	// ProtocolVersionIngressOnly is the first control protocol: ingress
	// bindings only.
	ProtocolVersionIngressOnly = 1
	// RelayProtocolVersion is the version of RelayRequest and RelayResponse on
	// the daemon's connector sockets (storage-relay.sock, egress.sock). It did
	// not change with the control protocol: daemons and storage connectors of
	// every release speak it.
	RelayProtocolVersion = 1
	maxFrameBytes        = 1024 * 1024
)

// UnsupportedVersionError is what a connector answers a request of a control
// protocol version it does not speak (a v1 connector answers it to v2).
const UnsupportedVersionError = "unsupported protocol version"

// ShuttingDownError is how a connector told to drain refuses every sync: it accepts nothing new and only finishes
// the sessions it carries. Connectors of every release answer it with these words.
const ShuttingDownError = "secure-link connector is shutting down"

// IsShuttingDown reports a sync refused by a draining connector: it never serves again.
func IsShuttingDown(err error) bool {
	return err != nil && strings.Contains(err.Error(), ShuttingDownError)
}

type BindingConfig struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	ListenHost string `json:"listenHost"`
	TargetHost string `json:"targetHost"`
	TargetPort uint16 `json:"targetPort"`
}

// EgressConfig is one egress listener of the connector: a workload on a link
// network connects to ListenHost:ListenPort, and the connector carries the
// connection through the daemon's egress socket (a RelayRequest with
// OwnerKind and ID). The daemon decides where the connection goes.
type EgressConfig struct {
	ID         string `json:"id"`
	OwnerKind  string `json:"ownerKind"`
	Generation uint64 `json:"generation"`
	// ListenHost is the connector's own IPv4 address on the link network.
	ListenHost string `json:"listenHost"`
	ListenPort uint16 `json:"listenPort"`
	// AllowedPrefix is the CIDR of that network; a peer outside it is closed
	// at once.
	AllowedPrefix string `json:"allowedPrefix"`
	// MaxSessions bounds the concurrent connections; 0 means no bound.
	MaxSessions int `json:"maxSessions,omitempty"`
	// TLSCAPEM and TLSServerName make the connector originate TLS over the
	// relayed stream (managed storage with TLS).
	TLSCAPEM      string `json:"tlsCaPem,omitempty"`
	TLSServerName string `json:"tlsServerName,omitempty"`
}

type SyncRequest struct {
	Version  int             `json:"version"`
	Bindings []BindingConfig `json:"bindings"`
	Egress   []EgressConfig  `json:"egress,omitempty"`
	// IngressPeer (v2) is the only address the ingress listeners accept connections from: the management network's
	// gateway, from which the daemon dials. Every other peer is closed at once. A v1 request has none (an older
	// daemon), and its ingress listeners accept every peer as before.
	IngressPeer string `json:"ingressPeer,omitempty"`
	// Drain (v2) stops a connector that a replacement took over from accepting: it closes every listener, keeps the
	// sessions it carries, and answers how many are still open (Active). Bindings and Egress are ignored.
	Drain bool `json:"drain,omitempty"`
}

type BindingStatus struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	Port       uint16 `json:"port"`
}

// Egress listener states.
const (
	EgressListening = "listening"
	EgressError     = "error"
)

// EgressStatus reports one egress listener. A listener that failed (State
// EgressError) never affects the other bindings of the request.
type EgressStatus struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
}

type SyncResponse struct {
	Version  int             `json:"version"`
	Bindings []BindingStatus `json:"bindings,omitempty"`
	Egress   []EgressStatus  `json:"egress,omitempty"`
	// Error refuses the ingress bindings of the request (or the whole request
	// when it is malformed); the egress statuses stand on their own.
	Error string `json:"error,omitempty"`
	// Active answers a Drain request: the sessions the connector still carries.
	Active int `json:"active,omitempty"`
}

// Drain tells a connector that a replacement took over to stop accepting and
// returns the sessions it still carries. A v1 connector cannot drain: the
// error says so, and the caller retires it the way it did before.
func Drain(ctx context.Context, socketPath string) (int, error) {
	response, err := exchange(ctx, socketPath, SyncRequest{Version: ProtocolVersion, Drain: true})
	if err != nil {
		return 0, err
	}
	if response.Version != ProtocolVersion || response.Error != "" {
		return 0, fmt.Errorf("secure-link connector cannot drain: %s", response.Error)
	}
	return response.Active, nil
}

// RelayRequest switches a connector into a single server-authorized raw TCP
// relay stream. It intentionally contains an owner kind and opaque binding ID,
// never a target address, port, Docker bind, or command.
type RelayRequest struct {
	Version   int    `json:"version"`
	OwnerKind string `json:"ownerKind"`
	BindingID string `json:"bindingId"`
}

type RelayResponse struct {
	Version int    `json:"version"`
	Error   string `json:"error,omitempty"`
}

func ReadJSON(r io.Reader, target any) error {
	var size [4]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return err
	}
	length := int(binary.BigEndian.Uint32(size[:]))
	if length < 1 || length > maxFrameBytes {
		return errors.New("invalid secure-link control frame length")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return err
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return fmt.Errorf("decode secure-link control frame: %w", err)
	}
	return nil
}

func WriteJSON(w io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode secure-link control frame: %w", err)
	}
	if len(payload) < 1 || len(payload) > maxFrameBytes {
		return errors.New("secure-link control frame is too large")
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(payload)))
	if _, err := w.Write(size[:]); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}

// Sync replaces the ingress bindings and the egress listeners of a connector
// (request.Egress nil: none) in protocol v2. A connector of protocol v1 is
// sent the ingress bindings only: the response then has Version
// ProtocolVersionIngressOnly and no egress statuses, and the caller reports
// its egress listeners as not served. When the connector refused the ingress
// bindings (response Error), the response is returned with the error, so the
// egress statuses it carries are kept.
func Sync(ctx context.Context, socketPath string, request SyncRequest) (*SyncResponse, error) {
	request.Version = ProtocolVersion
	response, err := exchange(ctx, socketPath, request)
	if err != nil {
		return nil, err
	}
	switch {
	case response.Version == ProtocolVersionIngressOnly && response.Error == UnsupportedVersionError:
		response, err = exchange(ctx, socketPath, SyncRequest{Version: ProtocolVersionIngressOnly, Bindings: request.Bindings})
		if err != nil {
			return nil, err
		}
		if response.Version != ProtocolVersionIngressOnly {
			return nil, errors.New("unsupported secure-link connector protocol version")
		}
		response.Egress = nil
	case response.Version != ProtocolVersion:
		return nil, errors.New("unsupported secure-link connector protocol version")
	}
	if response.Error != "" {
		return response, errors.New(response.Error)
	}
	return response, nil
}

func exchange(ctx context.Context, socketPath string, request SyncRequest) (*SyncResponse, error) {
	dialer := net.Dialer{}
	connection, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("connect secure-link connector: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := WriteJSON(connection, request); err != nil {
		return nil, err
	}
	var response SyncResponse
	if err := ReadJSON(connection, &response); err != nil {
		return nil, err
	}
	return &response, nil
}
