package docker

import (
	"strings"
	"testing"
)

func withDaemonIDs(t *testing.T, uid, gid int) {
	t.Helper()
	previousUID, previousGID := daemonEUID, daemonEGID
	t.Cleanup(func() { daemonEUID, daemonEGID = previousUID, previousGID })
	daemonEUID = func() int { return uid }
	daemonEGID = func() int { return gid }
}

func TestVolumeDataAccessNeedsRoot(t *testing.T) {
	withDaemonIDs(t, 0, 0)
	if err := requireVolumeDataAccess("exporting a volume for migration"); err != nil {
		t.Fatalf("root daemon refused volume data access: %v", err)
	}

	withDaemonIDs(t, 4242, 4242)
	err := requireVolumeDataAccess("exporting a volume for migration")
	if err == nil {
		t.Fatal("non-root daemon was allowed to read volume data")
	}
	for _, want := range []string{"exporting a volume for migration", "needs docker-daemon to run as root", "uid 4242"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name %q", err, want)
		}
	}
}

func TestConnectorGroupsFollowTheDaemonUser(t *testing.T) {
	withDaemonIDs(t, 0, 0)
	if groups := connectorGroupAdd(); groups != nil {
		t.Fatalf("root daemon gives connectors groups %v", groups)
	}
	if !sameConnectorGroups(nil) || sameConnectorGroups([]string{"991"}) {
		t.Fatal("root daemon must keep only connectors without extra groups")
	}

	withDaemonIDs(t, 999, 991)
	if groups := connectorGroupAdd(); len(groups) != 1 || groups[0] != "991" {
		t.Fatalf("non-root daemon connector groups = %v, want [991]", groups)
	}
	if sameConnectorGroups(nil) || !sameConnectorGroups([]string{"991"}) {
		t.Fatal("non-root daemon must replace a connector created without its group")
	}
	if !allowedConnectorGroups(nil) || !allowedConnectorGroups([]string{"991"}) || allowedConnectorGroups([]string{"0"}) || allowedConnectorGroups([]string{"991", "992"}) {
		t.Fatal("managed connectors may hold only the daemon's group")
	}
}
