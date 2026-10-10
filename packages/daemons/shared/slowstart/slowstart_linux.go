//go:build linux

package slowstart

import (
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	cubic = "cubic"
	reno  = "reno"
)

type guardSys struct {
	raw syscall.RawConn
}

func newGuardSys(conn net.Conn) (guardSys, bool) {
	sc, ok := conn.(syscall.Conn)
	if !ok {
		return guardSys{}, false
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return guardSys{}, false
	}
	usable := false
	if err := raw.Control(func(fd uintptr) {
		name, err := unix.GetsockoptString(int(fd), unix.IPPROTO_TCP, unix.TCP_CONGESTION)
		if err != nil || name != cubic {
			return
		}
		// A fresh connection: restarting CUBIC changes nothing, and it shows
		// whether this process may switch it.
		usable = restart(int(fd))
	}); err != nil {
		return guardSys{}, false
	}
	return guardSys{raw: raw}, usable
}

func (s guardSys) info() (tcpState, bool) {
	var state tcpState
	ok := false
	if err := s.raw.Control(func(fd uintptr) {
		info, err := unix.GetsockoptTCPInfo(int(fd), unix.IPPROTO_TCP, unix.TCP_INFO)
		if err != nil {
			return
		}
		state = tcpState{cwnd: info.Snd_cwnd, ssthresh: info.Snd_ssthresh, unacked: info.Unacked,
			lastDataSentMs: info.Last_data_sent, rtoUs: info.Rto, rttUs: info.Rtt}
		ok = true
	}); err != nil {
		return tcpState{}, false
	}
	return state, ok
}

func (s guardSys) restart() bool {
	restarted := false
	if err := s.raw.Control(func(fd uintptr) { restarted = restart(int(fd)) }); err != nil {
		return false
	}
	return restarted
}

// restart switches the socket to reno and back to CUBIC, which initialises
// CUBIC's state (HyStart's round trip among it); the window and the slow
// start threshold are kept.
func restart(fd int) bool {
	if unix.SetsockoptString(fd, unix.IPPROTO_TCP, unix.TCP_CONGESTION, reno) != nil {
		return false
	}
	if unix.SetsockoptString(fd, unix.IPPROTO_TCP, unix.TCP_CONGESTION, cubic) != nil {
		// Leave the connection as close to how it was as this process can.
		_ = unix.SetsockoptString(fd, unix.IPPROTO_TCP, unix.TCP_CONGESTION, cubic)
		return false
	}
	return true
}

func readState(conn net.Conn) (State, bool) {
	sc, ok := conn.(syscall.Conn)
	if !ok {
		return State{}, false
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return State{}, false
	}
	var state State
	read := false
	if err := raw.Control(func(fd uintptr) {
		info, err := unix.GetsockoptTCPInfo(int(fd), unix.IPPROTO_TCP, unix.TCP_INFO)
		if err != nil {
			return
		}
		state = State{SlowStartThreshold: info.Snd_ssthresh, BytesAcked: info.Bytes_acked, BytesReceived: info.Bytes_received, RTTUs: info.Rtt,
			RcvRTTUs: info.Rcv_rtt, MSS: info.Snd_mss}
		read = true
	}); err != nil {
		return State{}, false
	}
	return state, read
}
