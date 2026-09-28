//go:build !linux

package server

import (
	"errors"
	"net"
	"time"
)

func setAckTimeout(net.Conn, time.Duration) error { return nil }

func ackTimeout(net.Conn) (time.Duration, error) { return 0, errors.New("unsupported") }
