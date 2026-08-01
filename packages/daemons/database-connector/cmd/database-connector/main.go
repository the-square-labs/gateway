// database-connector exposes one ordinary database TCP port inside an
// application binding network and forwards bytes through a daemon-owned Unix
// socket. It intentionally contains no Gateway address, certificate or mTLS
// private key.
package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
)

const handshakeMagic = "GWDB1\n"
const maxConnectorSessions = 16

func main() {
	bindingID := strings.TrimSpace(os.Getenv("GATEWAY_DB_BINDING_ID"))
	socketPath := strings.TrimSpace(os.Getenv("GATEWAY_DB_SOCKET"))
	listenAddress := strings.TrimSpace(os.Getenv("GATEWAY_DB_LISTEN"))
	if bindingID == "" || len(bindingID) > 128 || socketPath == "" || listenAddress == "" {
		log.Fatal("GATEWAY_DB_BINDING_ID, GATEWAY_DB_SOCKET, and GATEWAY_DB_LISTEN are required")
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	// A connector owns exactly one binding, so this is a per-binding admission
	// cap. It bounds local sockets before an application can consume daemon or
	// database file descriptors.
	sessions := make(chan struct{}, maxConnectorSessions)
	for {
		appConn, err := listener.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		select {
		case sessions <- struct{}{}:
			go func() {
				defer func() { <-sessions }()
				handle(appConn, socketPath, bindingID)
			}()
		default:
			_ = appConn.Close()
		}
	}
}

func handle(appConn net.Conn, socketPath, bindingID string) {
	defer appConn.Close()
	daemonConn, err := net.Dial("unix", socketPath)
	if err != nil {
		log.Printf("connect daemon socket: %v", err)
		return
	}
	defer daemonConn.Close()
	if err := writeHandshake(daemonConn, bindingID); err != nil {
		log.Printf("authenticate daemon socket: %v", err)
		return
	}
	var copied sync.WaitGroup
	copied.Add(2)
	go func() {
		defer copied.Done()
		_, _ = io.Copy(daemonConn, appConn)
		closeWrite(daemonConn)
	}()
	go func() {
		defer copied.Done()
		_, _ = io.Copy(appConn, daemonConn)
		closeWrite(appConn)
	}()
	copied.Wait()
}

func writeHandshake(conn net.Conn, bindingID string) error {
	if len(bindingID) == 0 || len(bindingID) > 128 {
		return fmt.Errorf("invalid binding id length")
	}
	if _, err := io.WriteString(conn, handshakeMagic); err != nil {
		return err
	}
	var length [2]byte
	binary.BigEndian.PutUint16(length[:], uint16(len(bindingID)))
	if _, err := conn.Write(length[:]); err != nil {
		return err
	}
	_, err := io.WriteString(conn, bindingID)
	return err
}

func closeWrite(conn net.Conn) {
	if closeWriter, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = closeWriter.CloseWrite()
	}
}
