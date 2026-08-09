package docker

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

const (
	databaseTunnelMaxChunkBytes  = 1024 * 1024
	databaseTunnelHandshakeLimit = 128

	// The first-party connector mounts this directory so a daemon restart can
	// atomically replace the socket without pinning the old inode.
	DatabaseTunnelSocketDirectory = "database-tunnel"
	DatabaseTunnelSocketFilename  = "tunnel.sock"
	DatabaseTunnelHandshakeMagic  = "GWDB1\n"
)

func databaseTunnelSocketPath(stateDir string) string {
	return filepath.Join(stateDir, DatabaseTunnelSocketDirectory, DatabaseTunnelSocketFilename)
}

func prepareDatabaseTunnelSocketDirectory(stateDir string) error {
	return os.MkdirAll(filepath.Join(stateDir, DatabaseTunnelSocketDirectory), 0o755)
}

func writeDatabaseTunnelBytes(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func readDatabaseTunnelHandshake(r io.Reader) (string, error) {
	magic := make([]byte, len(DatabaseTunnelHandshakeMagic))
	if _, err := io.ReadFull(r, magic); err != nil {
		return "", err
	}
	if string(magic) != DatabaseTunnelHandshakeMagic {
		return "", errors.New("invalid database tunnel handshake")
	}
	var size [2]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return "", err
	}
	length := int(binary.BigEndian.Uint16(size[:]))
	if length < 1 || length > databaseTunnelHandshakeLimit {
		return "", errors.New("invalid database binding id length")
	}
	binding := make([]byte, length)
	if _, err := io.ReadFull(r, binding); err != nil {
		return "", err
	}
	if !utf8.Valid(binding) {
		return "", errors.New("database binding id is not valid UTF-8")
	}
	return string(binding), nil
}
