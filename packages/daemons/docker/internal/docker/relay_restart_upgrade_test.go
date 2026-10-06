package docker

import (
	"io"
	"net"
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
