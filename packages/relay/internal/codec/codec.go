package codec

import (
	"fmt"

	"google.golang.org/protobuf/proto"
)

// Frame lets the unknown-service proxy carry protobuf bytes without knowing
// the request or response schema. Registered relay services still use normal
// protobuf messages through the same codec.
type Frame []byte

type Codec struct{}

func (Codec) Name() string { return "proto" }

func (Codec) Marshal(value any) ([]byte, error) {
	switch message := value.(type) {
	case *Frame:
		return append([]byte(nil), (*message)...), nil
	case proto.Message:
		return proto.Marshal(message)
	default:
		return nil, fmt.Errorf("unsupported gRPC message type %T", value)
	}
}

func (Codec) Unmarshal(data []byte, value any) error {
	switch message := value.(type) {
	case *Frame:
		*message = append((*message)[:0], data...)
		return nil
	case proto.Message:
		return proto.Unmarshal(data, message)
	default:
		return fmt.Errorf("unsupported gRPC message type %T", value)
	}
}
