package docker

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"sync"
)

// linkListenerBootSkipped reports the missing boot step once per process.
var linkListenerBootSkipped sync.Once

// nonRootCapability tells Gateway that this docker-daemon runs as a non-root
// user, so the features that need root are shown as unavailable with that
// reason instead of being offered and failing: disk-image volumes, moving
// volume data between nodes, proxy Secure Links, managed storage links,
// installing Secure Runtime from Gateway, and the boot step that opens
// database link listeners before Docker.
const nonRootCapability = "docker_daemon_non_root_v1"

// daemonEUID is the effective uid the root-only checks use.
var daemonEUID = os.Geteuid

func runsWithoutRoot() bool { return daemonEUID() != 0 }

// runUserName names the daemon's user for messages.
func runUserName() string {
	uid := daemonEUID()
	if account, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		return account.Username
	}
	return "uid " + strconv.Itoa(uid)
}

// requireVolumeDataAccess refuses an operation that reads or writes a Docker
// volume's directory under the Docker data root, which only root can open.
func requireVolumeDataAccess(operation string) error {
	if !runsWithoutRoot() {
		return nil
	}
	return fmt.Errorf("%s needs docker-daemon to run as root: it reads volume data under the Docker data root, and this node runs docker-daemon as %s", operation, runUserName())
}

// rootOnlyCapabilities are features a daemon without root cannot serve: proxy
// Secure Links and managed storage links hand their connector containers a
// socket owned by uid 65532.
var rootOnlyCapabilities = map[string]bool{
	"proxy_secure_links_v1":      true,
	managedStorageLinkCapability: true,
}

// withoutRootOnlyCapabilities drops the root-only features from the advertised
// list, keeping the order of the rest.
func withoutRootOnlyCapabilities(values []string) []string {
	kept := values[:0:0]
	for _, value := range values {
		if !rootOnlyCapabilities[value] {
			kept = append(kept, value)
		}
	}
	return kept
}
