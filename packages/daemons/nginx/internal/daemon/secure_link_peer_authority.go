package daemon

import (
	"net"
	"os"
	"sync"
	"time"
)

// Authorizing a Secure Link peer must cost next to nothing: it runs for every
// connection nginx opens (B-22). The peer's credentials come from the socket
// (SO_PEERCRED); the managed nginx master's PID from a cache that runs no
// subprocess on this path (nginx.Manager.CachedPID). A worker process found
// to belong to that master is remembered, so later connections of the same
// worker cost a map lookup instead of a walk through /proc.
const (
	// peerAuthorizationTTL bounds how long a verified worker PID is trusted
	// without looking at /proc again (the cache is keyed by PID, uid and
	// master PID, so a restart of nginx invalidates it at once).
	peerAuthorizationTTL = 30 * time.Second
	peerAuthorizationMax = 4096
	// workerUIDTTL bounds how long the nginx worker uid used to own new
	// sockets is reused.
	workerUIDTTL = 10 * time.Second
)

type knownNginxPeer struct {
	uid    int
	master int
	until  time.Time
}

type nginxPeerAuthority struct {
	binary    string
	masterPID func() (int, error)
	// isManaged and workerUID are the /proc checks (replaceable in tests).
	isManaged func(peerPID, masterPID int, binary string) bool
	workerUID func(masterPID int, binary string) (int, error)

	mu        sync.Mutex
	known     map[int]knownNginxPeer
	uidMaster int
	uid       int
	uidUntil  time.Time
}

func newNginxPeerAuthority(binary string, masterPID func() (int, error)) *nginxPeerAuthority {
	return &nginxPeerAuthority{
		binary: binary, masterPID: masterPID,
		isManaged: isManagedNginxProcess, workerUID: managedNginxWorkerUID,
		known: map[int]knownNginxPeer{},
	}
}

// authorize reports whether a connection comes from this daemon or from a
// process of the managed nginx.
func (a *nginxPeerAuthority) authorize(connection net.Conn) bool {
	peer, err := unixPeerCredentials(connection)
	if err != nil {
		return false
	}
	return a.authorizePeer(peer, time.Now())
}

func (a *nginxPeerAuthority) authorizePeer(peer unixPeerIdentity, now time.Time) bool {
	if peer.pid == os.Getpid() {
		return true
	}
	if a.binary == "" || a.masterPID == nil || peer.pid <= 0 {
		return false
	}
	master, err := a.masterPID()
	if err != nil || master <= 0 {
		return false
	}
	a.mu.Lock()
	known, ok := a.known[peer.pid]
	a.mu.Unlock()
	if ok && known.uid == peer.uid && known.master == master && now.Before(known.until) {
		return true
	}
	if !a.isManaged(peer.pid, master, a.binary) {
		return false
	}
	a.mu.Lock()
	if len(a.known) >= peerAuthorizationMax {
		for pid, entry := range a.known {
			if !now.Before(entry.until) || entry.master != master {
				delete(a.known, pid)
			}
		}
		if len(a.known) >= peerAuthorizationMax {
			a.known = map[int]knownNginxPeer{}
		}
	}
	a.known[peer.pid] = knownNginxPeer{uid: peer.uid, master: master, until: now.Add(peerAuthorizationTTL)}
	a.mu.Unlock()
	return true
}

// socketOwnerUID is the uid of the managed nginx workers, which own the
// Secure Link sockets.
func (a *nginxPeerAuthority) socketOwnerUID() (int, error) {
	if a.masterPID == nil {
		return os.Getuid(), nil
	}
	master, err := a.masterPID()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	a.mu.Lock()
	if a.uidMaster == master && now.Before(a.uidUntil) {
		uid := a.uid
		a.mu.Unlock()
		return uid, nil
	}
	a.mu.Unlock()
	uid, err := a.workerUID(master, a.binary)
	if err != nil {
		return 0, err
	}
	a.mu.Lock()
	a.uidMaster, a.uid, a.uidUntil = master, uid, now.Add(workerUIDTTL)
	a.mu.Unlock()
	return uid, nil
}
