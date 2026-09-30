package docker

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// Lines as read on a Docker node: podinfo on :::9898 and 172.21.0.2:33489, Docker's embedded DNS on
// 127.0.0.11 and a v4-mapped loopback listener, plus an established connection.
const procNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0B00007F:9249 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 020015AC:82D1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 020015AC:26AA 030015AC:D431 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 20 4 30 10 -1
`

const procNetTCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:26AA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 6 1 0000000000000000 100 0 0 10 0
`

func TestReadListeningTCPPortsSkipsLoopbackAndNonListening(t *testing.T) {
	root := t.TempDir()
	netDir := filepath.Join(root, "42", "net")
	if err := os.MkdirAll(netDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(netDir, "tcp"), []byte(procNetTCP), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(netDir, "tcp6"), []byte(procNetTCP6), 0o644); err != nil {
		t.Fatal(err)
	}
	ports, err := readListeningTCPPorts(root, 42)
	if err != nil {
		t.Fatal(err)
	}
	if want := []uint16{9898, 33489}; !slices.Equal(ports, want) {
		t.Fatalf("ports = %v, want %v", ports, want)
	}
	if _, err := readListeningTCPPorts(root, 43); err == nil {
		t.Fatal("expected an error for a process without a readable namespace")
	}
}
