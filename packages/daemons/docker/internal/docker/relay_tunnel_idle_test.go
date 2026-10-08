package docker

import (
	"io"
	"net"
	"syscall"
	"testing"
	"time"
)

// roundTrip sends message through app and reads its echo.
func roundTrip(t *testing.T, app net.Conn, message string) {
	t.Helper()
	if _, err := app.Write([]byte(message)); err != nil {
		t.Fatalf("write %q: %v", message, err)
	}
	echo := make([]byte, len(message))
	_ = app.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(app, echo); err != nil || string(echo) != message {
		t.Fatalf("echo of %q: %q, %v", message, echo, err)
	}
	_ = app.SetReadDeadline(time.Time{})
}

func withRelayTunnelIdleLimit(t *testing.T, limit time.Duration) {
	previous := relayTunnelIdleLimit
	relayTunnelIdleLimit = limit
	t.Cleanup(func() { relayTunnelIdleLimit = previous })
}

// Pooled connections through database links and container links idle for hours. The rc.1 stand cut them after
// 5 minutes on both sides of the tunnel, although the relays keep them; neither daemon ends a link's tunnel for being
// idle, raw or resumable.
func TestLinkTunnelsStayOpenWhileIdle(t *testing.T) {
	withRelayTunnelIdleLimit(t, 100*time.Millisecond)
	for _, kinds := range []routeKinds{{connect: linkKindManagedDatabaseBinding, endpoint: "managed_database"}, containerLinkRoute} {
		for _, resumable := range []bool{false, true} {
			pair := newStreamPairFor(t, kinds, resumable, resumable)
			app, tunnel := pair.open()
			if (tunnel.session != nil) != resumable || tunnel.idle != 0 {
				t.Fatalf("%s tunnel resumable %v idle %s", kinds.connect, tunnel.session != nil, tunnel.idle)
			}
			roundTrip(t, app, "SELECT 1")
			time.Sleep(5 * relayTunnelIdleLimit)
			roundTrip(t, app, "SELECT 2")
			_ = app.Close()
		}
	}
}

// A route that keeps its idle limit (a backup run's) still ends its tunnel when it idles.
func TestBackupRouteTunnelEndsWhenIdle(t *testing.T) {
	withRelayTunnelIdleLimit(t, 100*time.Millisecond)
	pair := newStreamPairFor(t, routeKinds{connect: "database_backup_source", endpoint: "managed_database"}, false, false)
	app, tunnel := pair.open()
	if tunnel.idle != relayTunnelIdleLimit {
		t.Fatalf("backup tunnel idle limit %s", tunnel.idle)
	}
	roundTrip(t, app, "COPY")
	_ = app.SetReadDeadline(time.Now().Add(5 * time.Second))
	started := time.Now()
	if n, err := app.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("idle backup tunnel read %d, %v; want its end", n, err)
	}
	if waited := time.Since(started); waited < relayTunnelIdleLimit/2 {
		t.Fatalf("backup tunnel ended after %s, before its idle limit", waited)
	}
}

func TestRelaySourceIdleLimitFollowsTheRoutePolicy(t *testing.T) {
	for _, kind := range []string{linkKindManagedDatabaseBinding, linkKindManagedStorageBinding, containerLinkOwnerKind} {
		if limit := relaySourceIdleLimit(kind); limit != 0 {
			t.Errorf("%s idle limit %s, want none", kind, limit)
		}
	}
	for _, kind := range []string{"database_backup_source", "database_backup_restore", "storage_backup_target", "storage_backup_staging", ""} {
		if limit := relaySourceIdleLimit(kind); limit != relayTunnelIdleLimit {
			t.Errorf("%q idle limit %s, want %s", kind, limit, relayTunnelIdleLimit)
		}
	}
}

// A tunnel without an idle limit has TCP keepalive on its local socket, whichever wrappers carry it: a vanished peer
// still ends it.
func TestKeepLocalAliveReachesTheTCPSocket(t *testing.T) {
	local, app := testTCPPair(t)
	defer app.Close()
	defer local.Close()
	tcp := local.(*net.TCPConn)
	if err := tcp.SetKeepAlive(false); err != nil {
		t.Fatal(err)
	}
	flow := &linkFlowConn{Conn: &connectorConn{Conn: newDrainConn(tcp)}}
	keepLocalAlive(&linkCountedConn{Conn: flow, counts: &linkTrafficCounts{}})
	raw, err := tcp.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	enabled := 0
	if err := raw.Control(func(fd uintptr) {
		enabled, err = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_KEEPALIVE)
	}); err != nil {
		t.Fatal(err)
	}
	if err != nil || enabled == 0 {
		t.Fatalf("keepalive %d, %v", enabled, err)
	}
}
