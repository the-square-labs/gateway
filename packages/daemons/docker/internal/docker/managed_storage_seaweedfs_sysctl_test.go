package docker

import "testing"

func TestSeaweedFSContainersGetTheReceiveBuffers(t *testing.T) {
	if got := seaweedfsSysctls()["net.ipv4.tcp_rmem"]; got != "4096 2097152 16777216" {
		t.Fatalf("tcp_rmem = %q", got)
	}
	if !seaweedfsSysctlsOutdated(nil) || !seaweedfsSysctlsOutdated(map[string]string{"net.ipv4.tcp_rmem": "4096 131072 6291456"}) {
		t.Fatal("a container without the receive buffers counts as current")
	}
	if seaweedfsSysctlsOutdated(seaweedfsSysctls()) {
		t.Fatal("a current container counts as outdated")
	}
}
