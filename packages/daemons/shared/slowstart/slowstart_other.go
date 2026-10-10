//go:build !linux

package slowstart

import "net"

type guardSys struct{}

func newGuardSys(net.Conn) (guardSys, bool) { return guardSys{}, false }

func (guardSys) info() (tcpState, bool) { return tcpState{}, false }

func (guardSys) restart() bool { return false }

func readState(net.Conn) (State, bool) { return State{}, false }
