package relayresume

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// ErrMalformed reports a frame that does not parse as RSv1 records.
var ErrMalformed = errors.New("relayresume: malformed record")

// Record is one decoded record. Only the fields of its Type are set. Payload
// and Reason alias the parsed frame.
type Record struct {
	Type      byte
	Ack       uint64 // DATA, ACK, FIN
	Wnd       uint64 // ACK, HELLO, HELLO_ACK
	Payload   []byte // DATA
	Code      byte   // RST, RESUME_REJ, MIGRATE_REQ (reason)
	Reason    []byte // RST
	Version   byte   // HELLO, RESUME
	KeyID     string // HELLO, RESUME
	SessionID [SessionIDLen]byte
	Nonce     [NonceLen]byte // HELLO_ACK
	Epoch     uint64         // RESUME, RESUME_ACK
	RcvNxt    uint64         // RESUME, RESUME_ACK
	SendFrom  uint64         // RESUME_ACK
	MAC       [MACLen]byte   // HELLO, HELLO_ACK, RESUME, RESUME_ACK
}

// IsHandshake reports a handshake record (HELLO .. RESUME_REJ).
func (r *Record) IsHandshake() bool {
	return r.Type >= TypeHello && r.Type <= TypeResumeRej
}

// ParseRecord decodes the first record of frame and returns the bytes after
// it. A DATA record consumes the rest of the frame.
func ParseRecord(frame []byte) (Record, []byte, error) {
	var record Record
	if len(frame) == 0 {
		return record, nil, ErrMalformed
	}
	record.Type = frame[0]
	rest := frame[1:]
	var err error
	switch record.Type {
	case TypeData:
		if record.Ack, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if len(rest) == 0 {
			return record, nil, ErrMalformed
		}
		record.Payload = rest
		return record, nil, nil
	case TypeAck:
		if record.Ack, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if record.Wnd, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
	case TypeFin:
		if record.Ack, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
	case TypeRst:
		if len(rest) < 2 || len(rest) < 2+int(rest[1]) {
			return record, nil, ErrMalformed
		}
		record.Code = rest[0]
		record.Reason = rest[2 : 2+int(rest[1])]
		rest = rest[2+int(rest[1]):]
	case TypeClose:
	case TypeHello:
		if rest, err = readMagic(&record, rest); err != nil {
			return record, nil, err
		}
		if record.KeyID, rest, err = readKeyID(rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.SessionID[:], rest); err != nil {
			return record, nil, err
		}
		if record.Wnd, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.MAC[:], rest); err != nil {
			return record, nil, err
		}
	case TypeHelloAck:
		if rest, err = readFixed(record.SessionID[:], rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.Nonce[:], rest); err != nil {
			return record, nil, err
		}
		if record.Wnd, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.MAC[:], rest); err != nil {
			return record, nil, err
		}
	case TypeResume:
		if rest, err = readMagic(&record, rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.SessionID[:], rest); err != nil {
			return record, nil, err
		}
		if record.Epoch, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if record.RcvNxt, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if record.KeyID, rest, err = readKeyID(rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.MAC[:], rest); err != nil {
			return record, nil, err
		}
	case TypeResumeAck:
		if rest, err = readFixed(record.SessionID[:], rest); err != nil {
			return record, nil, err
		}
		if record.Epoch, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if record.RcvNxt, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if record.SendFrom, rest, err = readUvarint(rest); err != nil {
			return record, nil, err
		}
		if rest, err = readFixed(record.MAC[:], rest); err != nil {
			return record, nil, err
		}
	case TypeResumeRej:
		if rest, err = readFixed(record.SessionID[:], rest); err != nil {
			return record, nil, err
		}
		if len(rest) < 1 {
			return record, nil, ErrMalformed
		}
		record.Code = rest[0]
		rest = rest[1:]
	case TypeMigrateReq:
		if len(rest) < 1 {
			return record, nil, ErrMalformed
		}
		record.Code = rest[0]
		rest = rest[1:]
	default:
		return record, nil, fmt.Errorf("%w: unknown record type 0x%02x", ErrMalformed, record.Type)
	}
	return record, rest, nil
}

// ParseFrame decodes every record of frame.
func ParseFrame(frame []byte) ([]Record, error) {
	if len(frame) == 0 {
		return nil, ErrMalformed
	}
	var records []Record
	for len(frame) > 0 {
		record, rest, err := ParseRecord(frame)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
		frame = rest
	}
	return records, nil
}

// AppendRecord encodes record onto dst. It fails for a record that would not
// parse back (an empty DATA payload, a key id or reason out of range).
func AppendRecord(dst []byte, record *Record) ([]byte, error) {
	dst = append(dst, record.Type)
	switch record.Type {
	case TypeData:
		if len(record.Payload) == 0 {
			return nil, ErrMalformed
		}
		dst = binary.AppendUvarint(dst, record.Ack)
		dst = append(dst, record.Payload...)
	case TypeAck:
		dst = binary.AppendUvarint(dst, record.Ack)
		dst = binary.AppendUvarint(dst, record.Wnd)
	case TypeFin:
		dst = binary.AppendUvarint(dst, record.Ack)
	case TypeRst:
		if len(record.Reason) > MaxReasonLen {
			return nil, ErrMalformed
		}
		dst = append(dst, record.Code, byte(len(record.Reason)))
		dst = append(dst, record.Reason...)
	case TypeClose:
	case TypeHello:
		if !validKeyID(record.KeyID) {
			return nil, ErrMalformed
		}
		dst = append(dst, Magic...)
		dst = append(dst, Version, byte(len(record.KeyID)))
		dst = append(dst, record.KeyID...)
		dst = append(dst, record.SessionID[:]...)
		dst = binary.AppendUvarint(dst, record.Wnd)
		dst = append(dst, record.MAC[:]...)
	case TypeHelloAck:
		dst = append(dst, record.SessionID[:]...)
		dst = append(dst, record.Nonce[:]...)
		dst = binary.AppendUvarint(dst, record.Wnd)
		dst = append(dst, record.MAC[:]...)
	case TypeResume:
		if !validKeyID(record.KeyID) {
			return nil, ErrMalformed
		}
		dst = append(dst, Magic...)
		dst = append(dst, Version)
		dst = append(dst, record.SessionID[:]...)
		dst = binary.AppendUvarint(dst, record.Epoch)
		dst = binary.AppendUvarint(dst, record.RcvNxt)
		dst = append(dst, byte(len(record.KeyID)))
		dst = append(dst, record.KeyID...)
		dst = append(dst, record.MAC[:]...)
	case TypeResumeAck:
		dst = append(dst, record.SessionID[:]...)
		dst = binary.AppendUvarint(dst, record.Epoch)
		dst = binary.AppendUvarint(dst, record.RcvNxt)
		dst = binary.AppendUvarint(dst, record.SendFrom)
		dst = append(dst, record.MAC[:]...)
	case TypeResumeRej:
		dst = append(dst, record.SessionID[:]...)
		dst = append(dst, record.Code)
	case TypeMigrateReq:
		dst = append(dst, record.Code)
	default:
		return nil, fmt.Errorf("%w: unknown record type 0x%02x", ErrMalformed, record.Type)
	}
	return dst, nil
}

// AppendDataHeader appends a DATA header (type and ack); the payload follows.
func AppendDataHeader(dst []byte, ack uint64) []byte {
	return binary.AppendUvarint(append(dst, TypeData), ack)
}

// AppendAck appends an ACK record.
func AppendAck(dst []byte, ack, wnd uint64) []byte {
	return binary.AppendUvarint(binary.AppendUvarint(append(dst, TypeAck), ack), wnd)
}

// AppendFin appends a FIN record.
func AppendFin(dst []byte, ack uint64) []byte {
	return binary.AppendUvarint(append(dst, TypeFin), ack)
}

// AppendRst appends an RST record; reason is cut to MaxReasonLen bytes.
func AppendRst(dst []byte, code byte, reason string) []byte {
	if len(reason) > MaxReasonLen {
		reason = reason[:MaxReasonLen]
	}
	dst = append(dst, TypeRst, code, byte(len(reason)))
	return append(dst, reason...)
}

func uvarintLen(value uint64) int {
	n := 1
	for value >= 0x80 {
		value >>= 7
		n++
	}
	return n
}

func validKeyID(keyID string) bool {
	return len(keyID) >= 1 && len(keyID) <= MaxKeyIDLen
}

// readUvarint decodes a minimal unsigned LEB128 value of at most 64 bits.
func readUvarint(buffer []byte) (uint64, []byte, error) {
	var value uint64
	var shift uint
	for i := 0; i < len(buffer) && i < binary.MaxVarintLen64; i++ {
		b := buffer[i]
		if i == binary.MaxVarintLen64-1 && b > 1 {
			return 0, nil, ErrMalformed
		}
		if b < 0x80 {
			if b == 0 && i > 0 {
				return 0, nil, ErrMalformed
			}
			return value | uint64(b)<<shift, buffer[i+1:], nil
		}
		value |= uint64(b&0x7f) << shift
		shift += 7
	}
	return 0, nil, ErrMalformed
}

func readFixed(dst, buffer []byte) ([]byte, error) {
	if len(buffer) < len(dst) {
		return nil, ErrMalformed
	}
	copy(dst, buffer)
	return buffer[len(dst):], nil
}

func readMagic(record *Record, buffer []byte) ([]byte, error) {
	if len(buffer) < len(Magic)+1 || string(buffer[:len(Magic)]) != Magic {
		return nil, ErrMalformed
	}
	record.Version = buffer[len(Magic)]
	if record.Version != Version {
		return nil, ErrMalformed
	}
	return buffer[len(Magic)+1:], nil
}

func readKeyID(buffer []byte) (string, []byte, error) {
	if len(buffer) < 1 {
		return "", nil, ErrMalformed
	}
	n := int(buffer[0])
	if n < 1 || n > MaxKeyIDLen || len(buffer) < 1+n {
		return "", nil, ErrMalformed
	}
	return string(buffer[1 : 1+n]), buffer[1+n:], nil
}
