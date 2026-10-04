package nginx

import (
	"bytes"
	"path/filepath"
)

const maintenanceGuardFilename = "00-gateway-maintenance.conf"

// maintenanceGuardConfig is the http-level part of the maintenance guard Gateway renders into every managed route of
// a node that keeps maintenance flags (proxy_maintenance_flag_v1). The variables are the same for every route, so a
// node defines them once however many routes it serves; each request evaluates them only while its route's flag is
// set (Gateway's nginx-maintenance-flag-guard.ts).
//
//   - $gateway_maintenance is "1" while the route that handles the request is in maintenance: the route's guard sets it
//     when the flag file exists. Its default comes from this map, so reading it never logs an uninitialized variable.
//   - $gateway_maintenance_route names the guard location that answers the request, empty when the route handles it:
//     the paths the maintenance page itself needs and ACME challenges, and a request with a valid access cookie.
//   - $gateway_maintenance_cookie is the Cookie a route forwards: the request's own, without Gateway's access cookies
//     during maintenance. Each cookie goes with the separator that joined it to its neighbours (the first rule of a map
//     takes the cookie at the start, the second one anywhere after it), so no empty or leading ";" is left.
const maintenanceGuardConfig = `# Gateway managed: maintenance of the routes on this node (auto-generated).
map $pid $gateway_maintenance {
    default "";
}

map $gateway_maintenance $gateway_maintenance_route {
    default "";
    1 $gateway_maintenance_target;
}

map $uri $gateway_maintenance_target {
    default $gateway_maintenance_bypass;
    ~^/\.well-known/acme-challenge/ "";
    /.well-known/gateway-ingress-health "";
    /_gateway/maintenance-access gateway-maintenance-access;
    /_gateway/maintenance-access/status gateway-maintenance-status;
}

map $secure_link $gateway_maintenance_bypass {
    default gateway-maintenance;
    "1" "";
}

map $secure_link $gateway_maintenance_access {
    default false;
    "1" true;
}

map $http_cookie $gateway_maintenance_cookie_sig {
    default $http_cookie;
    "~^gateway_maintenance_access_sig=[^;]*(?:;\s*(.*))?$" "$1";
    "~^(.*?);\s*gateway_maintenance_access_sig=[^;]*(.*)$" "$1$2";
}

map $gateway_maintenance_cookie_sig $gateway_maintenance_cookie_stripped {
    default $gateway_maintenance_cookie_sig;
    "~^gateway_maintenance_access_exp=[^;]*(?:;\s*(.*))?$" "$1";
    "~^(.*?);\s*gateway_maintenance_access_exp=[^;]*(.*)$" "$1$2";
}

map $gateway_maintenance $gateway_maintenance_cookie {
    volatile;
    default $http_cookie;
    1 $gateway_maintenance_cookie_stripped;
}
`

// MaintenanceGuardConfigPath is the managed file in the config directory that holds the shared maps.
func MaintenanceGuardConfigPath(configDir string) string {
	return filepath.Join(configDir, maintenanceGuardFilename)
}

// EnsureMaintenanceGuardConfig writes the shared maps when they are missing or differ. It returns the content it
// replaced (nil when the file was missing) and whether it wrote.
func EnsureMaintenanceGuardConfig(configDir string) (previous []byte, written bool, err error) {
	path := MaintenanceGuardConfigPath(configDir)
	existing, err := ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	if bytes.Equal(existing, []byte(maintenanceGuardConfig)) {
		return existing, false, nil
	}
	return existing, true, WriteAtomic(path, []byte(maintenanceGuardConfig))
}
