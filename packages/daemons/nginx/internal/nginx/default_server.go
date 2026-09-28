package nginx

import "path/filepath"

const gatewayDefaultServerFilename = "00-gateway-default-server.conf"

// gatewayDefaultServerConfig is the managed HTTPS catch-all. It must be the
// only default_server for 443/[::]:443 across every Gateway-managed conf.d
// file (route templates never set default_server; see
// nginx-template.service.ts) so nginx always resolves an unmatched SNI/Host
// here instead of falling through to the first loaded route.
const gatewayDefaultServerConfig = `# Gateway managed default server (auto-injected)
# Rejects any TLS request whose SNI or Host does not match a configured
# route, so a deleted route's hostname (or any other hostname pointed at
# this node) cannot fall through to another route's server block.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`

// EnsureDefaultServer writes (or repairs) the managed HTTPS catch-all server
// block described above. It is idempotent: an existing file with the exact
// managed contents is left untouched, so callers can invoke it on every
// daemon start without spurious reloads. Returns true when the file was
// created or its contents changed.
func EnsureDefaultServer(configDir string) (bool, error) {
	path := DefaultServerConfigPath(configDir)
	existing, err := ReadFile(path)
	if err != nil {
		return false, err
	}
	if existing != nil && string(existing) == gatewayDefaultServerConfig {
		return false, nil
	}
	return true, WriteAtomic(path, []byte(gatewayDefaultServerConfig))
}

// DefaultServerConfigPath returns the path of the managed default server
// config file within the given Gateway conf.d directory.
func DefaultServerConfigPath(configDir string) string {
	return filepath.Join(configDir, gatewayDefaultServerFilename)
}
