package tlsbatch

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func testCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "tlsbatch"}, DNSNames: []string{"tlsbatch"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// countingConn counts the writes that reach the socket.
type countingConn struct {
	net.Conn
	writes atomic.Int64
}

func (c *countingConn) Write(data []byte) (int, error) {
	c.writes.Add(1)
	return c.Conn.Write(data)
}

func tcpPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server := <-accepted
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	return client, server
}

// pair is a TLS connection whose client side batches; raw counts its sends.
func pair(t *testing.T) (client net.Conn, server *tls.Conn, raw *countingConn) {
	t.Helper()
	certificate := testCertificate(t)
	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(certificate.Certificate[0])
	pool.AddCert(leaf)
	rawClient, rawServer := tcpPair(t)
	raw = &countingConn{Conn: rawClient}
	below := Below(raw)
	tlsClient := tls.Client(below, &tls.Config{RootCAs: pool, ServerName: "tlsbatch", MinVersion: tls.VersionTLS13})
	server = tls.Server(rawServer, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13})
	errs := make(chan error, 1)
	go func() { errs <- server.Handshake() }()
	if err := tlsClient.Handshake(); err != nil {
		t.Fatal(err)
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	return Above(tlsClient, below), server, raw
}

func TestOneWriteLeavesInOneSend(t *testing.T) {
	client, server, raw := pair(t)
	payload := bytes.Repeat([]byte("0123456789abcdef"), 16*1024) // 256 KiB: 16 records
	received := make(chan []byte, 1)
	go func() {
		buffer := make([]byte, len(payload))
		_, _ = io.ReadFull(server, buffer)
		received <- buffer
	}()
	before := raw.writes.Load()
	if _, err := client.Write(payload); err != nil {
		t.Fatal(err)
	}
	if sends := raw.writes.Load() - before; sends != 1 {
		t.Fatalf("a 256 KiB write left in %d sends, want 1", sends)
	}
	if got := <-received; !bytes.Equal(got, payload) {
		t.Fatal("the peer read other bytes")
	}
}

func TestLargeWritesLeaveInPieces(t *testing.T) {
	client, server, raw := pair(t)
	payload := make([]byte, 3*MaxBatch)
	_, _ = rand.Read(payload)
	received := make(chan []byte, 1)
	go func() {
		buffer := make([]byte, len(payload))
		_, _ = io.ReadFull(server, buffer)
		received <- buffer
	}()
	before := raw.writes.Load()
	if _, err := client.Write(payload); err != nil {
		t.Fatal(err)
	}
	if sends := raw.writes.Load() - before; sends < 3 || sends > 4 {
		t.Fatalf("a %d-byte write left in %d sends, want 3-4", len(payload), sends)
	}
	if got := <-received; !bytes.Equal(got, payload) {
		t.Fatal("the peer read other bytes")
	}
}

// Writes from several goroutines and both directions at once arrive intact
// and in order per writer.
func TestConcurrentWritesStayInOrder(t *testing.T) {
	client, server, _ := pair(t)
	const writers, rounds, size = 4, 200, 5000
	var wait sync.WaitGroup
	for w := range writers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for r := range rounds {
				message := bytes.Repeat([]byte{byte(w)}, size)
				message[0], message[1] = byte(w), byte(r)
				if _, err := client.Write(message); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	// The other direction: the client reads while it writes (key updates and
	// alerts a TLS connection may write while reading go out at once).
	go func() {
		for range 100 {
			_, _ = server.Write([]byte("ping"))
		}
	}()
	go func() { _, _ = io.Copy(io.Discard, client) }()
	next := make([]int, writers)
	buffer := make([]byte, size)
	for range writers * rounds {
		if _, err := io.ReadFull(server, buffer); err != nil {
			t.Fatal(err)
		}
		w, r := int(buffer[0]), int(buffer[1])
		if w >= writers || r != next[w]%256 || !bytes.Equal(buffer[2:], bytes.Repeat([]byte{byte(w)}, size-2)) {
			t.Fatalf("message %d of writer %d arrived as writer %d round %d", next[w], w, w, r)
		}
		next[w]++
	}
	wait.Wait()
}

func TestBelowExposesTheSocket(t *testing.T) {
	rawClient, _ := tcpPair(t)
	below := Below(rawClient)
	if _, err := below.SyscallConn(); err != nil {
		t.Fatal(err)
	}
	above := Above(rawClient, below).(interface {
		SyscallConn() (syscall.RawConn, error)
	})
	if _, err := above.SyscallConn(); err != nil {
		t.Fatal(err)
	}
}
