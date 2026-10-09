package docker

import (
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// scriptedConn hands out one scripted chunk per Read, like separate segments from the workload.
type scriptedConn struct {
	net.Conn
	reads chan string
}

func (c *scriptedConn) Read(buffer []byte) (int, error) {
	data, ok := <-c.reads
	if !ok {
		return 0, io.EOF
	}
	return copy(buffer, data), nil
}

func (c *scriptedConn) Write(buffer []byte) (int, error) { return len(buffer), nil }

// retiresWhenQuiet reports whether a connector retirement would close the tunnel at its first quiet tick.
func retiresWhenQuiet(connection *drainConn) bool {
	now := time.Now().UnixNano()
	connection.opened = now - int64(3*time.Second)
	connection.lastWrite.Store(now - int64(2*time.Second))
	connection.lastRead.Store(now - int64(time.Second))
	var tunnels proxyTunnelSet
	closed := false
	tunnels.add(connection, func() { closed = true })
	tunnels.drainWhere(func(*drainConn) bool { return true }, 0, time.Millisecond, true)
	return closed
}

func TestDrainConnResponseFraming(t *testing.T) {
	const get = "GET / HTTP/1.1\r\n\r\n"
	body := func(n int) string { return strings.Repeat("x", n) }
	type step struct {
		write string // a request written to the workload before the read
		read  string // what the workload sends next
		mid   bool   // the response is in progress afterwards
	}
	for name, tc := range map[string]struct {
		steps    []step
		upgraded bool
	}{
		"no body 204":               {steps: []step{{get, "HTTP/1.1 204 No Content\r\n\r\n", false}}},
		"no body 304 with a length": {steps: []step{{get, "HTTP/1.1 304 Not Modified\r\nContent-Length: 500\r\n\r\n", false}}},
		"HEAD with a length": {steps: []step{
			{"HEAD / HTTP/1.1\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n", false},
			// The next request is a GET again: its body counts.
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n", true},
		}},
		"empty body": {steps: []step{{get, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", false}}},
		"length counts down": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n12345", true},
			{"", "678", true},
			{"", "90", false},
		}},
		"length with the body in the head's read": {steps: []step{{get, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n12345", false}}},
		"two responses in one read": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", false},
		}},
		"second response started in the read that ends the first": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n", true},
			{"", "123456789", false},
		}},
		"chunked in one read": {steps: []step{{get, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", false}}},
		"chunked terminator split across reads": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n", true},
			{"", "0\r", true},
			{"", "\n\r", true},
			{"", "\n", false},
		}},
		"chunked terminator after the head": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r\n\r\n", true},
			{"", "0\r\n\r\n", false},
		}},
		"head split across reads": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Le", true},
			{"", "ngth: 0\r\n\r\n", false},
		}},
		"status line split across reads": {steps: []step{
			{get, "HTTP/1.", true},
			{"", "1 204 No Content\r\n\r\n", false},
		}},
		"interim 100 then the answer": {steps: []step{
			{get, "HTTP/1.1 100 Continue\r\n\r\n", false},
			{"", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc", false},
		}},
		"interim 100 then an answer with a body to come": {steps: []step{
			{get, "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na", true},
		}},
		"HTTP inside a sized body is not parsed": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nHTTP/1.1 101 Switching Protocols\r\n\r\n", true},
			{"", "HTTP/1.1 204 No Content\r\n\r\n", true},
		}},
		"HTTP inside a chunked body is not parsed": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", true},
			{"", "20\r\nHTTP/1.1 204 No Content\r\n\r\n\r\n", true},
			{"", "0\r\n\r\n", false},
		}},
		"event stream": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: 5\r\n\r\n", true},
			{"", "data: 1\n\n", true},
			{"", body(20), true},
		}},
		"close-delimited": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npart", true},
			{"", "more", true},
		}},
		"switching protocols": {upgraded: true, steps: []step{
			{get, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n", true},
			{"", "\x81\x04pong", true},
		}},
		"not an HTTP answer": {steps: []step{{get, "\x00\x01 raw bytes", true}}},
		"unparseable length": {steps: []step{{get, "HTTP/1.1 200 OK\r\nContent-Length: ten\r\n\r\n", true}}},
		"keep-alive then a stream": {steps: []step{
			{get, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", false},
			{get, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n", true},
		}},
	} {
		t.Run(name, func(t *testing.T) {
			reads := make(chan string, 1)
			connection := newDrainConn(&scriptedConn{reads: reads})
			buffer := make([]byte, 64<<10)
			for i, step := range tc.steps {
				if step.write != "" {
					if _, err := connection.Write([]byte(step.write)); err != nil {
						t.Fatal(err)
					}
				}
				reads <- step.read
				if _, err := connection.Read(buffer); err != nil {
					t.Fatal(err)
				}
				if got := connection.midResponse.Load(); got != step.mid && !connection.upgraded.Load() {
					t.Fatalf("step %d: mid-response %v, want %v", i, got, step.mid)
				}
				// What the retirement does with the tunnel: an upgraded one is kept through upgraded.
				if want := !step.mid; retiresWhenQuiet(connection) != want {
					t.Fatalf("step %d: retired when quiet %v, want %v", i, !want, want)
				}
			}
			if connection.upgraded.Load() != tc.upgraded {
				t.Fatalf("upgraded %v, want %v", connection.upgraded.Load(), tc.upgraded)
			}
		})
	}
}
