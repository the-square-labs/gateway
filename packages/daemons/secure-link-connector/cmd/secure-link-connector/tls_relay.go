package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A link whose target speaks TLS (managed storage with TLS) has the connector originate TLS over the relayed stream.
// The TLS state of crypto/tls cannot move to another process, so the connector runs the handshake with crypto/tls and
// then carries the session's records itself (TLS 1.3, AES-GCM): traffic secrets, sequence numbers and the bytes of a
// record read or written in part are all it holds, and a handover passes them on with the session (label
// sessionLabelTLS). A session that negotiated anything else (TLS 1.2, ChaCha20) stays with crypto/tls and, on a
// replacement, with the replaced connector.

const (
	// sessionLabelTLS carries a relayTLS session's state through a handover.
	sessionLabelTLS = "tls"
	// tlsRecordPayload is the most plaintext one record carries.
	tlsRecordPayload = 16384
	// tlsMaxCiphertext bounds a record's body (RFC 8446 5.2).
	tlsMaxCiphertext = tlsRecordPayload + 256
	// tlsCloseNotifyWait bounds the close_notify a closing session sends, as crypto/tls does.
	tlsCloseNotifyWait = 5 * time.Second
)

const (
	recordChangeCipherSpec = 20
	recordAlert            = 21
	recordHandshake        = 22
	recordApplicationData  = 23

	handshakeNewSessionTicket = 4
	handshakeKeyUpdate        = 24
)

// clientTLS runs the TLS client handshake over remote and returns the TLS connection (remote itself without
// tlsConfig): with movable, a relayTLS when the session can move to another process, else crypto/tls's connection.
func clientTLS(ctx context.Context, remote net.Conn, tlsConfig *tls.Config, movable bool) (net.Conn, error) {
	if tlsConfig == nil {
		return remote, nil
	}
	if !movable {
		tlsRemote := tls.Client(remote, tlsConfig)
		handshakeCtx, cancel := context.WithTimeout(ctx, targetDialTimeout)
		defer cancel()
		if err := tlsRemote.HandshakeContext(handshakeCtx); err != nil {
			return nil, err
		}
		return tlsRemote, nil
	}
	var keyLog bytes.Buffer
	config := tlsConfig.Clone()
	config.KeyLogWriter = &keyLog
	// crypto/tls reads no byte past the record that ends the handshake: the records after it are the relayTLS's.
	bounded := &recordBoundedConn{Conn: remote}
	tlsRemote := tls.Client(bounded, config)
	handshakeCtx, cancel := context.WithTimeout(ctx, targetDialTimeout)
	defer cancel()
	if err := tlsRemote.HandshakeContext(handshakeCtx); err != nil {
		return nil, err
	}
	state := tlsRemote.ConnectionState()
	if state.Version != tls.VersionTLS13 || bounded.midRecord() {
		return tlsRemote, nil
	}
	clientSecret, serverSecret := trafficSecretsOf(keyLog.String())
	session, err := newRelayTLS(remote, state.CipherSuite, clientSecret, serverSecret)
	if err != nil {
		// A suite the connector does not carry itself (ChaCha20): crypto/tls carries the session.
		return tlsRemote, nil
	}
	return session, nil
}

// recordBoundedConn hands crypto/tls whole TLS records and never more than the record it reads.
type recordBoundedConn struct {
	net.Conn
	header   []byte
	bodyLeft int
}

func (c *recordBoundedConn) Read(p []byte) (int, error) {
	if len(c.header) == 0 && c.bodyLeft == 0 {
		header := make([]byte, 5)
		if _, err := io.ReadFull(c.Conn, header); err != nil {
			return 0, err
		}
		c.header, c.bodyLeft = header, int(binary.BigEndian.Uint16(header[3:5]))
	}
	if len(c.header) > 0 {
		n := copy(p, c.header)
		c.header = c.header[n:]
		return n, nil
	}
	if len(p) > c.bodyLeft {
		p = p[:c.bodyLeft]
	}
	n, err := c.Conn.Read(p)
	c.bodyLeft -= n
	return n, err
}

func (c *recordBoundedConn) midRecord() bool { return len(c.header) > 0 || c.bodyLeft > 0 }

// trafficSecretsOf reads the first application traffic secrets from crypto/tls's key log (NSS key log format).
func trafficSecretsOf(log string) (client, server []byte) {
	for _, line := range strings.Split(log, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		secret, err := hex.DecodeString(fields[2])
		if err != nil {
			continue
		}
		switch fields[0] {
		case "CLIENT_TRAFFIC_SECRET_0":
			client = secret
		case "SERVER_TRAFFIC_SECRET_0":
			server = secret
		}
	}
	return client, server
}

// trafficKeys is one direction's record protection: its traffic secret and the next record's sequence number.
type trafficKeys struct {
	suite  uint16
	secret []byte
	seq    uint64
	aead   cipher.AEAD
	iv     []byte
}

func suiteHash(suite uint16) (func() hash.Hash, int, bool) {
	switch suite {
	case tls.TLS_AES_128_GCM_SHA256:
		return sha256.New, 16, true
	case tls.TLS_AES_256_GCM_SHA384:
		return sha512.New384, 32, true
	}
	return nil, 0, false
}

// expandLabel is HKDF-Expand-Label (RFC 8446 7.1) with an empty context.
func expandLabel(newHash func() hash.Hash, secret []byte, label string, length int) ([]byte, error) {
	full := "tls13 " + label
	info := make([]byte, 0, 4+len(full))
	info = binary.BigEndian.AppendUint16(info, uint16(length))
	info = append(info, byte(len(full)))
	info = append(info, full...)
	info = append(info, 0)
	return hkdf.Expand(newHash, secret, string(info), length)
}

func newTrafficKeys(suite uint16, secret []byte, seq uint64) (*trafficKeys, error) {
	newHash, keyLength, ok := suiteHash(suite)
	if !ok {
		return nil, fmt.Errorf("TLS cipher suite %#04x is not carried by the connector", suite)
	}
	if len(secret) != newHash().Size() {
		return nil, errors.New("TLS traffic secret of the wrong length")
	}
	key, err := expandLabel(newHash, secret, "key", keyLength)
	if err != nil {
		return nil, err
	}
	iv, err := expandLabel(newHash, secret, "iv", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &trafficKeys{suite: suite, secret: append([]byte(nil), secret...), seq: seq, aead: aead, iv: iv}, nil
}

func (k *trafficKeys) nonce() []byte {
	nonce := append([]byte(nil), k.iv...)
	var seq [8]byte
	binary.BigEndian.PutUint64(seq[:], k.seq)
	for i := range seq {
		nonce[len(nonce)-8+i] ^= seq[i]
	}
	return nonce
}

// next moves on to the next traffic secret (a KeyUpdate).
func (k *trafficKeys) next() (*trafficKeys, error) {
	newHash, _, _ := suiteHash(k.suite)
	secret, err := expandLabel(newHash, k.secret, "traffic upd", newHash().Size())
	if err != nil {
		return nil, err
	}
	return newTrafficKeys(k.suite, secret, 0)
}

// relayTLS is a TLS 1.3 client session over a relayed stream, carried record by record by the connector.
type relayTLS struct {
	conn net.Conn

	readMu     sync.Mutex
	in         *trafficKeys
	raw        []byte // bytes of the records not read yet
	plain      []byte // plaintext not delivered yet
	hand       []byte // a handshake message not complete yet
	readClosed bool   // the server's close_notify arrived

	writeMu         sync.Mutex
	out             *trafficKeys
	pending         []byte // ciphertext of records written in part
	closeNotifySent bool
	// sealedAhead: the first bytes of the next Write are already sealed in pending (a record written in part is not
	// counted as written, so its writer writes it again, and it is flushed then).
	sealedAhead int

	handedOver atomic.Bool
}

func newRelayTLS(conn net.Conn, suite uint16, clientSecret, serverSecret []byte) (*relayTLS, error) {
	out, err := newTrafficKeys(suite, clientSecret, 0)
	if err != nil {
		return nil, err
	}
	in, err := newTrafficKeys(suite, serverSecret, 0)
	if err != nil {
		return nil, err
	}
	return &relayTLS{conn: conn, in: in, out: out}, nil
}

// HandoverInner is the relayed stream: a handover passes its socket on, with the state (snapshotLabels).
func (t *relayTLS) HandoverInner() net.Conn { return t.conn }

// MarkHandedOver: another process carries the session now; closing this copy sends nothing.
func (t *relayTLS) MarkHandedOver() { t.handedOver.Store(true) }

func (t *relayTLS) LocalAddr() net.Addr                      { return t.conn.LocalAddr() }
func (t *relayTLS) RemoteAddr() net.Addr                     { return t.conn.RemoteAddr() }
func (t *relayTLS) SetDeadline(deadline time.Time) error     { return t.conn.SetDeadline(deadline) }
func (t *relayTLS) SetReadDeadline(deadline time.Time) error { return t.conn.SetReadDeadline(deadline) }
func (t *relayTLS) SetWriteDeadline(deadline time.Time) error {
	return t.conn.SetWriteDeadline(deadline)
}

func (t *relayTLS) Read(p []byte) (int, error) {
	t.readMu.Lock()
	defer t.readMu.Unlock()
	for len(t.plain) == 0 {
		if t.readClosed {
			return 0, io.EOF
		}
		record, ok, err := t.nextRecord()
		if err != nil {
			return 0, err
		}
		if !ok {
			buffer := make([]byte, 32*1024)
			n, err := t.conn.Read(buffer)
			t.raw = append(t.raw, buffer[:n]...)
			if n == 0 && err != nil {
				return 0, err
			}
			continue
		}
		if err := t.openRecord(record); err != nil {
			return 0, err
		}
	}
	n := copy(p, t.plain)
	t.plain = t.plain[n:]
	if len(t.plain) == 0 {
		t.plain = nil
	}
	return n, nil
}

// nextRecord takes the first whole record of raw.
func (t *relayTLS) nextRecord() ([]byte, bool, error) {
	if len(t.raw) < 5 {
		return nil, false, nil
	}
	length := int(binary.BigEndian.Uint16(t.raw[3:5]))
	if length > tlsMaxCiphertext {
		return nil, false, errors.New("tls: oversized record")
	}
	if len(t.raw) < 5+length {
		return nil, false, nil
	}
	record := t.raw[:5+length]
	t.raw = t.raw[5+length:]
	if len(t.raw) == 0 {
		t.raw = nil
	}
	return record, true, nil
}

func (t *relayTLS) openRecord(record []byte) error {
	header, body := record[:5], record[5:]
	switch header[0] {
	case recordChangeCipherSpec:
		return nil
	case recordApplicationData:
	default:
		return fmt.Errorf("tls: unexpected record type %d", header[0])
	}
	inner, err := t.in.aead.Open(nil, t.in.nonce(), body, header)
	if err != nil {
		return errors.New("tls: bad record MAC")
	}
	t.in.seq++
	end := len(inner)
	for end > 0 && inner[end-1] == 0 {
		end--
	}
	if end == 0 {
		return errors.New("tls: record without a content type")
	}
	contentType, data := inner[end-1], inner[:end-1]
	switch contentType {
	case recordApplicationData:
		t.plain = append(t.plain, data...)
	case recordAlert:
		if len(data) == 2 && data[1] == 0 {
			t.readClosed = true
			return nil
		}
		if len(data) == 2 {
			return fmt.Errorf("tls: remote error: alert %d", data[1])
		}
		return errors.New("tls: malformed alert")
	case recordHandshake:
		t.hand = append(t.hand, data...)
		return t.handshakeMessages()
	default:
		return fmt.Errorf("tls: unexpected content type %d", contentType)
	}
	return nil
}

// handshakeMessages handles the post-handshake messages: session tickets are not used, a KeyUpdate moves on to the
// next secret (and, when asked, so does the connector's own direction).
func (t *relayTLS) handshakeMessages() error {
	for len(t.hand) >= 4 {
		length := int(t.hand[1])<<16 | int(t.hand[2])<<8 | int(t.hand[3])
		if length > 1<<16 {
			return errors.New("tls: oversized handshake message")
		}
		if len(t.hand) < 4+length {
			return nil
		}
		message := t.hand[:4+length]
		t.hand = append([]byte(nil), t.hand[4+length:]...)
		switch message[0] {
		case handshakeNewSessionTicket:
		case handshakeKeyUpdate:
			if length != 1 {
				return errors.New("tls: malformed KeyUpdate")
			}
			next, err := t.in.next()
			if err != nil {
				return err
			}
			t.in = next
			if message[4] == 1 {
				if err := t.sendKeyUpdate(); err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
					return err
				}
			}
		default:
			return fmt.Errorf("tls: unexpected handshake message %d", message[0])
		}
	}
	if len(t.hand) == 0 {
		t.hand = nil
	}
	return nil
}

func (t *relayTLS) sendKeyUpdate() error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	t.pending = append(t.pending, t.seal(recordHandshake, []byte{handshakeKeyUpdate, 0, 0, 1, 0})...)
	next, err := t.out.next()
	if err != nil {
		return err
	}
	t.out = next
	return t.flushControlLocked()
}

// seal protects one record with the connector's keys.
func (t *relayTLS) seal(contentType byte, data []byte) []byte {
	inner := make([]byte, 0, len(data)+1)
	inner = append(inner, data...)
	inner = append(inner, contentType)
	header := []byte{recordApplicationData, 3, 3, 0, 0}
	binary.BigEndian.PutUint16(header[3:], uint16(len(inner)+t.out.aead.Overhead()))
	record := t.out.aead.Seal(header, t.out.nonce(), inner, header)
	t.out.seq++
	return record
}

// flushLocked writes what records were written in part; what it could not write stays pending.
func (t *relayTLS) flushLocked() error {
	for len(t.pending) > 0 {
		n, err := t.conn.Write(t.pending)
		t.pending = t.pending[n:]
		if err != nil {
			return err
		}
	}
	t.pending = nil
	return nil
}

// Write seals p in records. A record written in part is not counted as written: it stays pending, its writer writes
// its bytes again (a pipe, after a stop), and the rest of the record goes out then, without sealing them twice.
func (t *relayTLS) Write(p []byte) (int, error) {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if t.closeNotifySent {
		return 0, errors.New("tls: write after close_notify")
	}
	if err := t.flushLocked(); err != nil {
		return 0, err
	}
	written := min(t.sealedAhead, len(p))
	t.sealedAhead = 0
	for written < len(p) {
		chunk := p[written:min(len(p), written+tlsRecordPayload)]
		t.pending = t.seal(recordApplicationData, chunk)
		if err := t.flushLocked(); err != nil {
			t.sealedAhead = len(chunk)
			return written, err
		}
		written += len(chunk)
	}
	return written, nil
}

// flushControlLocked writes a control record (close_notify, KeyUpdate) that no writer will write again: a stop of the
// session interrupts it (deadline), and it carries on once the stop ends, or goes along with a handover.
func (t *relayTLS) flushControlLocked() error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		err := t.flushLocked()
		if err == nil || !errors.Is(err, os.ErrDeadlineExceeded) || t.handedOver.Load() || time.Now().After(deadline) {
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// CloseWrite sends close_notify, as crypto/tls does.
func (t *relayTLS) CloseWrite() error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if t.closeNotifySent {
		return nil
	}
	t.pending = append(t.pending, t.seal(recordAlert, []byte{1, 0})...)
	t.closeNotifySent = true
	return t.flushControlLocked()
}

// Close sends close_notify (within tlsCloseNotifyWait) and closes the stream, as crypto/tls does; once handed over it
// only lets go of this process's copy.
func (t *relayTLS) Close() error {
	if !t.handedOver.Load() {
		_ = t.conn.SetWriteDeadline(time.Now().Add(tlsCloseNotifyWait))
		_ = t.CloseWrite()
	}
	return t.conn.Close()
}

// relayTLSState is what a handover passes on of a relayTLS session.
type relayTLSState struct {
	Suite           uint16 `json:"suite"`
	InSecret        []byte `json:"inSecret"`
	InSeq           uint64 `json:"inSeq"`
	OutSecret       []byte `json:"outSecret"`
	OutSeq          uint64 `json:"outSeq"`
	Raw             []byte `json:"raw,omitempty"`
	Plain           []byte `json:"plain,omitempty"`
	Hand            []byte `json:"hand,omitempty"`
	ReadClosed      bool   `json:"readClosed,omitempty"`
	Pending         []byte `json:"pending,omitempty"`
	CloseNotifySent bool   `json:"closeNotifySent,omitempty"`
	SealedAhead     int    `json:"sealedAhead,omitempty"`
}

// snapshotLabels is the session's state for a handover, read once both directions of its pipe stopped.
func (t *relayTLS) snapshotLabels() map[string]string {
	t.readMu.Lock()
	defer t.readMu.Unlock()
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	state := relayTLSState{
		Suite: t.in.suite, InSecret: t.in.secret, InSeq: t.in.seq, OutSecret: t.out.secret, OutSeq: t.out.seq,
		Raw: t.raw, Plain: t.plain, Hand: t.hand, ReadClosed: t.readClosed, Pending: t.pending, CloseNotifySent: t.closeNotifySent,
		SealedAhead: t.sealedAhead,
	}
	encoded, _ := json.Marshal(state)
	return map[string]string{sessionLabelTLS: base64.StdEncoding.EncodeToString(encoded)}
}

// restoreRelayTLS carries on a session a replaced connector handed over, over its relayed stream conn.
func restoreRelayTLS(conn net.Conn, encoded string) (*relayTLS, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	var state relayTLSState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	in, err := newTrafficKeys(state.Suite, state.InSecret, state.InSeq)
	if err != nil {
		return nil, err
	}
	out, err := newTrafficKeys(state.Suite, state.OutSecret, state.OutSeq)
	if err != nil {
		return nil, err
	}
	return &relayTLS{conn: conn, in: in, out: out, raw: state.Raw, plain: state.Plain, hand: state.Hand, readClosed: state.ReadClosed,
		pending: state.Pending, closeNotifySent: state.CloseNotifySent, sealedAhead: state.SealedAhead}, nil
}

// flushHandedOver writes the records the replaced connector wrote in part, before anything else is written.
func (t *relayTLS) flushHandedOver(wait time.Duration) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if len(t.pending) == 0 {
		return nil
	}
	_ = t.conn.SetWriteDeadline(time.Now().Add(wait))
	err := t.flushLocked()
	_ = t.conn.SetWriteDeadline(time.Time{})
	return err
}
