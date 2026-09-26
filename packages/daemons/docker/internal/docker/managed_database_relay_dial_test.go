package docker

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const testLinkDatabaseID = "0b7f1c5e-8a1d-4f3e-9c7a-2d4e6f8a0b1c"

type testLinkPKI struct {
	caPEM []byte
	leaf  tls.Certificate
}

func newTestLinkPKI(t *testing.T, commonName string) testLinkPKI {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Gateway Database CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Like Gateway-issued leaves: identity in the CN, node service addresses
	// in the SANs (never the container bridge address the daemon dials).
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: commonName},
		IPAddresses:  []net.IP{net.ParseIP("203.0.113.10")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return testLinkPKI{
		caPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		leaf:  tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey},
	}
}

// tcpTestPair returns both ends of a loopback TCP connection: kernel buffers
// keep the TLS handshake from stalling the way synchronous pipes can.
func tcpTestPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			close(accepted)
			return
		}
		accepted <- conn
	}()
	dialed, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, ok := <-accepted
	if !ok {
		t.Fatal("accept loopback connection")
	}
	t.Cleanup(func() { _ = dialed.Close(); _ = server.Close() })
	return dialed, server
}

func postgresTestStartupMessage() []byte {
	body := []byte("user\x00app\x00database\x00appdb\x00\x00")
	packet := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(packet[0:4], uint32(8+len(body)))
	binary.BigEndian.PutUint32(packet[4:8], 196608)
	return append(packet, body...)
}

func postgresTestNegotiation(code uint32) []byte {
	packet := make([]byte, 8)
	binary.BigEndian.PutUint32(packet[0:4], 8)
	binary.BigEndian.PutUint32(packet[4:8], code)
	return packet
}

func readPostgresTestPacket(conn io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	rest := make([]byte, binary.BigEndian.Uint32(header)-4)
	if _, err := io.ReadFull(conn, rest); err != nil {
		return nil, err
	}
	return append(header, rest...), nil
}

// fakeTLSPostgres accepts SSLRequest, answers 'S', serves the leaf and
// reports the first packet received over TLS; it then answers "ok".
func fakeTLSPostgres(t *testing.T, conn net.Conn, leaf tls.Certificate) <-chan []byte {
	t.Helper()
	received := make(chan []byte, 1)
	go func() {
		defer close(received)
		request := make([]byte, 8)
		if _, err := io.ReadFull(conn, request); err != nil || !bytes.Equal(request, postgresTestNegotiation(postgresSSLRequestCode)) {
			return
		}
		if _, err := conn.Write([]byte{'S'}); err != nil {
			return
		}
		server := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12})
		if err := server.Handshake(); err != nil {
			return
		}
		packet, err := readPostgresTestPacket(server)
		if err != nil {
			return
		}
		received <- packet
		_, _ = server.Write([]byte("ok"))
	}()
	return received
}

func newTestLinkStream(frames ...[]byte) *testRelayFrameStream {
	stream := &testRelayFrameStream{sent: make(chan *relayv1.TunnelFrame, 8), received: make(chan *relayv1.TunnelFrame, len(frames)+1)}
	for _, data := range frames {
		stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}
	}
	return stream
}

func newTestLinkManager(t *testing.T, caPEM []byte) *managedDatabaseManager {
	t.Helper()
	manager := &managedDatabaseManager{root: t.TempDir()}
	dir := manager.tlsDirectory(managedDatabaseRecord{ID: testLinkDatabaseID})
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), caPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	return manager
}

func tlsPostgresRecord() managedDatabaseRecord {
	return managedDatabaseRecord{ID: testLinkDatabaseID, Type: "postgres", TLSEnabled: true}
}

func expectPacket(t *testing.T, received <-chan []byte, want []byte) {
	t.Helper()
	select {
	case got, ok := <-received:
		if !ok {
			t.Fatal("PostgreSQL did not receive a packet over TLS")
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("PostgreSQL received %q, want %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for PostgreSQL")
	}
}

func TestManagedPostgresLinkOpensTLSForPlainStartup(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	received := fakeTLSPostgres(t, postgresSide, pki.leaf)
	startup := postgresTestStartupMessage()
	// The startup packet arrives split across relay frames.
	stream := newTestLinkStream(startup[:3], startup[3:])

	linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer linked.Close()
	if _, ok := linked.(*tls.Conn); !ok {
		t.Fatalf("link connection is %T, want *tls.Conn", linked)
	}
	expectPacket(t, received, startup)
	answer := make([]byte, 2)
	if _, err := io.ReadFull(linked, answer); err != nil || string(answer) != "ok" {
		t.Fatalf("read PostgreSQL answer through TLS: %q %v", answer, err)
	}
	if len(stream.sent) != 0 {
		t.Fatalf("daemon answered the client for a plain startup: %d frames", len(stream.sent))
	}
}

func TestManagedPostgresLinkAnswersGSSENCRequestAndForwardsStartup(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	received := fakeTLSPostgres(t, postgresSide, pki.leaf)
	startup := postgresTestStartupMessage()
	stream := newTestLinkStream(postgresTestNegotiation(postgresGSSENCRequestCode), startup)

	linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer linked.Close()
	answer := <-stream.sent
	if data := answer.GetData(); data == nil || !bytes.Equal(data.Data, []byte{'N'}) {
		t.Fatalf("GSSENCRequest answer = %v, want 'N'", answer)
	}
	expectPacket(t, received, startup)
}

// A client that asks for TLS (the Gateway's verified database tools, psql
// sslmode=prefer/require) keeps its own end-to-end TLS session: the request
// reaches PostgreSQL unchanged and the daemon adds no TLS layer.
func TestManagedPostgresLinkPassesClientSSLRequestThrough(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	stream := newTestLinkStream(postgresTestNegotiation(postgresSSLRequestCode))
	forwarded := make(chan []byte, 1)
	go func() {
		request := make([]byte, 8)
		_, _ = io.ReadFull(postgresSide, request)
		forwarded <- request
	}()

	linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer linked.Close()
	if linked != daemonSide {
		t.Fatalf("client-negotiated TLS must use the plain connection, got %T", linked)
	}
	if got := <-forwarded; !bytes.Equal(got, postgresTestNegotiation(postgresSSLRequestCode)) {
		t.Fatalf("PostgreSQL received %v, want the client's SSLRequest", got)
	}
	if len(stream.sent) != 0 {
		t.Fatal("daemon must not answer a client SSLRequest itself")
	}
}

func TestManagedPostgresLinkForwardsCancelRequestOverTLS(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	received := fakeTLSPostgres(t, postgresSide, pki.leaf)
	cancelRequest := make([]byte, 16)
	binary.BigEndian.PutUint32(cancelRequest[0:4], 16)
	binary.BigEndian.PutUint32(cancelRequest[4:8], postgresCancelRequestCode)
	binary.BigEndian.PutUint32(cancelRequest[8:12], 4242)
	binary.BigEndian.PutUint32(cancelRequest[12:16], 0xdeadbeef)
	stream := newTestLinkStream(cancelRequest)

	linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer linked.Close()
	expectPacket(t, received, cancelRequest)
}

func TestManagedDatabaseLinkKeepsPlainDialWithoutPostgresTLS(t *testing.T) {
	manager := &managedDatabaseManager{root: t.TempDir()}
	for _, record := range []managedDatabaseRecord{
		{ID: testLinkDatabaseID, Type: "postgres", TLSEnabled: false},
		{ID: testLinkDatabaseID, Type: "redis", TLSEnabled: true},
		{ID: testLinkDatabaseID, Type: "clickhouse", TLSEnabled: true},
	} {
		daemonSide, other := tcpTestPair(t)
		// An empty stream: any read of the client would block the test.
		stream := &testRelayFrameStream{sent: make(chan *relayv1.TunnelFrame, 1), received: make(chan *relayv1.TunnelFrame)}
		linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, record, stream, func() {})
		if err != nil || linked != daemonSide {
			t.Fatalf("%s tls=%v: got %T %v, want the plain connection", record.Type, record.TLSEnabled, linked, err)
		}
		_ = daemonSide.Close()
		_ = other.Close()
	}
}

func TestManagedPostgresLinkRejectsCertificateOfAnotherDatabase(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity("11111111-2222-3333-4444-555555555555"))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	fakeTLSPostgres(t, postgresSide, pki.leaf)
	stream := newTestLinkStream(postgresTestStartupMessage())

	_, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err == nil || !strings.Contains(err.Error(), "not issued for this managed database") {
		t.Fatalf("error = %v, want identity rejection", err)
	}
}

func TestManagedPostgresLinkRejectsCertificateFromAnotherCA(t *testing.T) {
	served := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	trusted := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, trusted.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	fakeTLSPostgres(t, postgresSide, served.leaf)
	stream := newTestLinkStream(postgresTestStartupMessage())

	_, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err == nil || !strings.Contains(err.Error(), "not issued by the managed database CA") {
		t.Fatalf("error = %v, want CA rejection", err)
	}
}

func TestManagedPostgresLinkBoundsStuckPostgres(t *testing.T) {
	previous := managedPostgresLinkServerTimeout
	managedPostgresLinkServerTimeout = 200 * time.Millisecond
	t.Cleanup(func() { managedPostgresLinkServerTimeout = previous })
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	go func() { _, _ = io.Copy(io.Discard, postgresSide) }() // reads, never answers
	stream := newTestLinkStream(postgresTestStartupMessage())

	started := time.Now()
	_, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err == nil || !strings.Contains(err.Error(), "SSLRequest answer") {
		t.Fatalf("error = %v, want a bounded SSLRequest failure", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("stuck PostgreSQL held the link for %s", elapsed)
	}
}

func TestManagedPostgresLinkFailsWhenClientClosesBeforeStartup(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	defer postgresSide.Close()
	stream := &testRelayFrameStream{sent: make(chan *relayv1.TunnelFrame, 1), received: make(chan *relayv1.TunnelFrame, 1)}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}

	if _, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {}); err == nil {
		t.Fatal("expected an error when the client closes before its startup packet")
	}
}

// The relay client's half-close reaches PostgreSQL through the daemon's TLS
// session (close_notify), so the bridge ends like a plain link.
func TestManagedPostgresLinkBridgesHalfCloseThroughTLS(t *testing.T) {
	pki := newTestLinkPKI(t, managedPostgresLinkIdentity(testLinkDatabaseID))
	manager := newTestLinkManager(t, pki.caPEM)
	daemonSide, postgresSide := tcpTestPair(t)
	startup := postgresTestStartupMessage()
	serverDone := make(chan string, 1)
	go func() {
		defer close(serverDone)
		request := make([]byte, 8)
		if _, err := io.ReadFull(postgresSide, request); err != nil {
			return
		}
		_, _ = postgresSide.Write([]byte{'S'})
		server := tls.Server(postgresSide, &tls.Config{Certificates: []tls.Certificate{pki.leaf}, MinVersion: tls.VersionTLS12})
		received, err := io.ReadAll(server) // until the client's close_notify
		if err != nil {
			return
		}
		_, _ = server.Write([]byte("response"))
		_ = server.Close()
		serverDone <- string(received)
	}()
	stream := newTestLinkStream(startup, []byte("query"))
	linked, err := manager.prepareLinkConnection(context.Background(), daemonSide, tlsPostgresRecord(), stream, func() {})
	if err != nil {
		t.Fatal(err)
	}
	stream.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}
	bridgeDone := make(chan error, 1)
	go func() { bridgeDone <- bridgeRelayConnection(linked, stream, 1024, func() {}) }()

	select {
	case received := <-serverDone:
		if received != string(startup)+"query" {
			t.Fatalf("PostgreSQL received %q", received)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PostgreSQL did not see the client's half-close")
	}
	select {
	case err := <-bridgeDone:
		if err != nil {
			t.Fatalf("bridge error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not finish")
	}
	var response bytes.Buffer
	for len(stream.sent) > 0 {
		if data := (<-stream.sent).GetData(); data != nil {
			response.Write(data.Data)
		}
	}
	if response.String() != "response" {
		t.Fatalf("relayed response = %q", response.String())
	}
}
