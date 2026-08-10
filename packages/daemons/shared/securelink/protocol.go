package securelink

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
)

const (
	ProtocolVersion = 1
	maxFrameBytes   = 1024 * 1024
)

type BindingConfig struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	ListenHost string `json:"listenHost"`
	TargetHost string `json:"targetHost"`
	TargetPort uint16 `json:"targetPort"`
}

type SyncRequest struct {
	Version  int             `json:"version"`
	Bindings []BindingConfig `json:"bindings"`
}

type BindingStatus struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	Port       uint16 `json:"port"`
}

type SyncResponse struct {
	Version  int             `json:"version"`
	Bindings []BindingStatus `json:"bindings,omitempty"`
	Error    string          `json:"error,omitempty"`
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

func Sync(ctx context.Context, socketPath string, bindings []BindingConfig) (*SyncResponse, error) {
	dialer := net.Dialer{}
	connection, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("connect secure-link connector: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	request := SyncRequest{Version: ProtocolVersion, Bindings: bindings}
	if err := WriteJSON(connection, request); err != nil {
		return nil, err
	}
	var response SyncResponse
	if err := ReadJSON(connection, &response); err != nil {
		return nil, err
	}
	if response.Version != ProtocolVersion {
		return nil, errors.New("unsupported secure-link connector protocol version")
	}
	if response.Error != "" {
		return nil, errors.New(response.Error)
	}
	return &response, nil
}
