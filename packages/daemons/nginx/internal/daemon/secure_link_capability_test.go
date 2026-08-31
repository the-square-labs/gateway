package daemon

import "testing"

func TestSocketOnlySecureLinkCapabilityIsAdvertised(t *testing.T) {
	for _, capability := range (&NginxPlugin{}).capabilities() {
		if capability == "nginx_secure_link_socket_only_v1" {
			return
		}
	}
	t.Fatal("socket-only Secure Link capability is not advertised")
}
