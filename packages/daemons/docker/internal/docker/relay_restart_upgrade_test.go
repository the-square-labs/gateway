package docker

import (
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// workloadPair is a drain-tracked connection to a fake workload and the
// workload's end.
func workloadPair(t *testing.T) (*drainConn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	workload, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); workload.Close() })
	return newDrainConn(client), workload
}

// exchange sends request through the tunnel and reads the workload's answer.
func exchangeThrough(t *testing.T, tunnel *drainConn, workload net.Conn, request, answer string) {
	t.Helper()
	if _, err := tunnel.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(workload, make([]byte, len(request))); err != nil {
		t.Fatal(err)
	}
	if _, err := workload.Write([]byte(answer)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(tunnel, make([]byte, len(answer))); err != nil {
		t.Fatal(err)
	}
}

// A websocket (an HTTP connection upgraded with 101) is not closed between its
// messages when its connector is retired; a keep-alive HTTP connection still
// is, between requests. A daemon restart still closes both once idle.
func TestConnectorRetirementKeepsUpgradedConnections(t *testing.T) {
	var tunnels proxyTunnelSet
	websocket, websocketWorkload := workloadPair(t)
	plain, plainWorkload := workloadPair(t)
	exchangeThrough(t, websocket, websocketWorkload, "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n",
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n")
	exchangeThrough(t, plain, plainWorkload, "GET / HTTP/1.1\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	if !websocket.upgraded.Load() || plain.upgraded.Load() {
		t.Fatalf("upgraded: websocket %v, plain %v", websocket.upgraded.Load(), plain.upgraded.Load())
	}
	cancelled := map[*drainConn]bool{}
	tunnels.add(websocket, func() { cancelled[websocket] = true })
	tunnels.add(plain, func() { cancelled[plain] = true })
	// Messages every 100 ms: between them the websocket looks idle.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 5; i++ {
			exchangeThrough(t, websocket, websocketWorkload, "ping", "pong")
			time.Sleep(100 * time.Millisecond)
		}
	}()
	busy := tunnels.drainWhere(func(*drainConn) bool { return true }, 600*time.Millisecond, 10*time.Millisecond, true)
	<-done
	if busy != 1 || cancelled[websocket] || !cancelled[plain] {
		t.Fatalf("busy %d, websocket cancelled %v, keep-alive cancelled %v", busy, cancelled[websocket], cancelled[plain])
	}
	// A daemon restart drains the upgraded connection too once it is idle.
	if busy := tunnels.drainWhere(func(*drainConn) bool { return true }, time.Second, 10*time.Millisecond, false); busy != 0 || !cancelled[websocket] {
		t.Fatalf("restart drain: busy %d, websocket cancelled %v", busy, cancelled[websocket])
	}
}

// A response that is still streaming is not idle between its parts (stand rc.7 O-14: an event stream with an event
// every ~100 ms was cut by the 100 ms quiet rule): an event stream, a chunked body and a body of a known length stay
// on the retired connector until they end, while a finished keep-alive response is closed. A chunked or sized body
// that has ended is closed at the next quiet tick. A daemon restart still closes every tunnel once idle.
func TestConnectorRetirementKeepsStreamingResponses(t *testing.T) {
	var tunnels proxyTunnelSet
	const (
		request = "GET / HTTP/1.1\r\n\r\n"
		gap     = 120 * time.Millisecond
	)
	names := []string{"sse", "chunked", "sized", "keepalive"}
	conns := map[string]*drainConn{}
	workloads := map[string]net.Conn{}
	cancelled := map[string]bool{}
	for _, name := range names {
		name := name
		conns[name], workloads[name] = workloadPair(t)
		tunnels.add(conns[name], func() { cancelled[name] = true })
	}
	exchangeThrough(t, conns["keepalive"], workloads["keepalive"], request, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	// The tunnel side reads whatever the workload sends, like the bridge does.
	for _, name := range names[:3] {
		if _, err := conns[name].Write([]byte(request)); err != nil {
			t.Fatal(err)
		}
		if _, err := io.ReadFull(workloads[name], make([]byte, len(request))); err != nil {
			t.Fatal(err)
		}
		go io.Copy(io.Discard, conns[name])
	}
	stopEvents := make(chan struct{})
	var events, bodies sync.WaitGroup
	send := func(name string, parts []string) {
		defer bodies.Done()
		for i, part := range parts {
			if i > 0 {
				time.Sleep(gap)
			}
			if _, err := workloads[name].Write([]byte(part)); err != nil {
				return
			}
		}
	}
	events.Add(1)
	bodies.Add(2)
	go func() {
		defer events.Done()
		if _, err := workloads["sse"].Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")); err != nil {
			return
		}
		for {
			select {
			case <-stopEvents:
				return
			case <-time.After(gap):
				if _, err := workloads["sse"].Write([]byte("data: tick\n\n")); err != nil {
					return
				}
			}
		}
	}()
	chunked := []string{"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"}
	for i := 0; i < 4; i++ {
		chunked = append(chunked, "5\r\nhello\r\n")
	}
	go send("chunked", append(chunked, "0\r\n\r\n"))
	sized := []string{"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n"}
	for i := 0; i < 10; i++ {
		sized = append(sized, strings.Repeat("x", 100))
	}
	go send("sized", sized)
	all := func(*drainConn) bool { return true }

	// While they stream only the finished keep-alive response goes.
	busy := tunnels.drainWhere(all, 400*time.Millisecond, 10*time.Millisecond, true)
	if busy != 3 || !cancelled["keepalive"] || cancelled["sse"] || cancelled["chunked"] || cancelled["sized"] {
		t.Fatalf("while streaming: busy %d, cancelled %v", busy, cancelled)
	}
	// Once the chunked and sized bodies ended they are closed at the first quiet tick; the event stream never ends.
	bodies.Wait()
	busy = tunnels.drainWhere(all, 400*time.Millisecond, 10*time.Millisecond, true)
	if busy != 1 || !cancelled["chunked"] || !cancelled["sized"] || cancelled["sse"] {
		t.Fatalf("after the bodies ended: busy %d, cancelled %v", busy, cancelled)
	}
	// A daemon restart drains the event stream too once it is quiet.
	close(stopEvents)
	events.Wait()
	if busy := tunnels.drainWhere(all, time.Second, 10*time.Millisecond, false); busy != 0 || !cancelled["sse"] {
		t.Fatalf("restart drain: busy %d, cancelled %v", busy, cancelled)
	}
}

func TestSwitchingProtocols(t *testing.T) {
	for data, want := range map[string]bool{
		"HTTP/1.1 101 Switching Protocols\r\n": true,
		"HTTP/1.0 101 Switching Protocols\r\n": true,
		"HTTP/1.1 200 OK\r\n":                  false,
		"HTTP/1.1 10":                          false,
		"\x81\x04ping":                         false,
	} {
		if got := switchingProtocols([]byte(data)); got != want {
			t.Errorf("%q: %v", data, got)
		}
	}
}
