package main

import (
	"bytes"
	"crypto/tls"
	"io"
	"math/rand/v2"
	"net"
	"os"
	"testing"
	"time"
)

// budgetConn is one end of a byte stream in memory: writes go to out until the budget is spent (then the rest of a
// write fails as a stop's deadline does), reads come from in.
type budgetConn struct {
	net.Conn
	in, out *bytes.Buffer
	budget  int
}

func (c *budgetConn) Read(p []byte) (int, error) {
	if c.in.Len() == 0 {
		return 0, io.EOF
	}
	return c.in.Read(p)
}

func (c *budgetConn) Write(p []byte) (int, error) {
	if c.budget >= 0 && len(p) > c.budget {
		n, _ := c.out.Write(p[:c.budget])
		c.budget = 0
		return n, os.ErrDeadlineExceeded
	}
	if c.budget >= 0 {
		c.budget -= len(p)
	}
	return c.out.Write(p)
}

func (c *budgetConn) SetDeadline(time.Time) error      { return nil }
func (c *budgetConn) SetWriteDeadline(time.Time) error { return nil }
func (c *budgetConn) SetReadDeadline(time.Time) error  { return nil }

// The record layer writes a batch of records per write and opens records straight into the reader's buffer; a write
// stopped inside a batch (a handover's freeze) counts only whole records as written, and writing the rest again
// sends every byte once, in order, under the right sequence numbers.
func TestRelayTLSBatchedRecordsSurviveAStoppedWrite(t *testing.T) {
	client, server := bytes.Repeat([]byte{1}, 48), bytes.Repeat([]byte{2}, 48)
	var wire bytes.Buffer
	writerConn := &budgetConn{out: &wire, in: &bytes.Buffer{}, budget: 100_000}
	writer, err := newRelayTLS(writerConn, tls.TLS_AES_256_GCM_SHA384, client, server)
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 600<<10)
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range payload {
		payload[i] = byte(rng.Uint32())
	}
	sent := 0
	for sent < len(payload) {
		end := min(len(payload), sent+256<<10)
		n, err := writer.Write(payload[sent:end])
		if n%tlsRecordPayload != 0 && sent+n != end {
			t.Fatalf("a write counted %d bytes, not whole records", n)
		}
		sent += n
		if err != nil {
			if writerConn.budget != 0 {
				t.Fatal(err)
			}
			writerConn.budget = -1 // the stop ends: write the rest again
		}
	}
	// The peer's view: its "in" keys are the writer's "out" keys.
	reader, err := newRelayTLS(&budgetConn{in: &wire, out: &bytes.Buffer{}, budget: -1}, tls.TLS_AES_256_GCM_SHA384, server, client)
	if err != nil {
		t.Fatal(err)
	}
	var got []byte
	for _, size := range []int{100, 70 << 10, 256 << 10, 3} {
		buffer := make([]byte, size)
		for {
			n, err := reader.Read(buffer)
			got = append(got, buffer[:n]...)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) >= len(payload) {
				break
			}
			if size < 1024 && len(got) > 300<<10 {
				break
			}
		}
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("read %d bytes, want the %d written, in order", len(got), len(payload))
	}
}
