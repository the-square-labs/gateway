package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"syscall"
	"testing"
	"time"
)

// The connector's cost per GiB on its two hot paths, against what rc.8 ran there: a plain session (io.Copy between
// the sockets, which splices) and a storage TLS session read (crypto/tls). Run on Linux:
// go test -run x -bench SessionCost -benchtime 4x ./cmd/secure-link-connector
func BenchmarkSessionCost(b *testing.B) {
	const size = 256 << 20
	for _, mode := range []string{"io.Copy", "session pipe"} {
		b.Run("plain "+mode, func(b *testing.B) {
			b.SetBytes(size)
			measure(b, func() {
				clientA, connectorA := tcpPair(b)
				connectorB, serverB := tcpPair(b)
				done := make(chan struct{})
				go func() {
					defer close(done)
					if mode == "io.Copy" {
						go func() { _, _ = io.Copy(connectorA, connectorB) }()
						_, _ = io.Copy(connectorB, connectorA)
						_ = connectorB.(*net.TCPConn).CloseWrite()
						return
					}
					newSessionSet().pipe(connectorA, connectorB, egressLabels("bench"), nil)
				}()
				go func() { _, _ = io.CopyN(clientA, zeroes{}, size); _ = clientA.(*net.TCPConn).CloseWrite() }()
				if n, _ := io.Copy(io.Discard, serverB); n != size {
					b.Fatalf("moved %d", n)
				}
				_ = serverB.Close()
				<-done
				for _, c := range []net.Conn{clientA, connectorA, connectorB} {
					_ = c.Close()
				}
			})
		})
	}
	config := benchTLSConfig(b)
	for _, movable := range []bool{false, true} {
		name := "TLS GET crypto/tls"
		if movable {
			name = "TLS GET relayTLS"
		}
		b.Run(name, func(b *testing.B) {
			b.SetBytes(size)
			measure(b, func() {
				connectorSide, storageSide := tcpPair(b)
				go func() {
					server := tls.Server(storageSide, config.server)
					_, _ = io.CopyN(server, zeroes{}, size)
					_ = server.Close()
				}()
				remote, err := clientTLS(context.Background(), connectorSide, config.client, movable)
				if err != nil {
					b.Fatal(err)
				}
				workload, client := tcpPair(b)
				go func() { _, _ = io.Copy(workload, remote); _ = workload.Close() }()
				if n, _ := io.Copy(io.Discard, client); n != size {
					b.Fatalf("moved %d", n)
				}
				_ = remote.Close()
				_ = client.Close()
			})
		})
	}
}

type zeroes struct{}

func (zeroes) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func tcpPair(b *testing.B) (net.Conn, net.Conn) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { c, _ := listener.Accept(); accepted <- c }()
	dialed, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		b.Fatal(err)
	}
	return dialed, <-accepted
}

// measure runs one transfer per iteration and reports the process CPU per GiB moved.
func measure(b *testing.B, transfer func()) {
	var before, after syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &before)
	b.ResetTimer()
	for range b.N {
		transfer()
	}
	b.StopTimer()
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &after)
	cpu := time.Duration(syscall.TimevalToNsec(after.Utime)-syscall.TimevalToNsec(before.Utime)) +
		time.Duration(syscall.TimevalToNsec(after.Stime)-syscall.TimevalToNsec(before.Stime))
	gib := float64(b.N) * float64(256<<20) / float64(1<<30)
	b.ReportMetric(cpu.Seconds()/gib, "cpu-s/GiB")
}

type benchTLS struct{ server, client *tls.Config }

func benchTLSConfig(b *testing.B) benchTLS {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		b.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "storage.test"}, DNSNames: []string{"storage.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		b.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return benchTLS{
		server: &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, CipherSuites: nil},
		client: &tls.Config{RootCAs: pool, ServerName: "storage.test", MinVersion: tls.VersionTLS13},
	}
}
