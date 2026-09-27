package leasefence

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestRecordsRoundTripAndMalformedFilesAreReported(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: testID, PolicyID: "p1", Slot: 2, DeadlineNs: 42}); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: "short"}); err == nil {
		t.Fatal("a record needs a full container id")
	}
	if err := os.WriteFile(filepath.Join(dir.RecordsDir(), "junk.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	records, problems, err := dir.ReadRecords()
	if err != nil || len(records) != 1 || len(problems) != 1 {
		t.Fatalf("records %+v problems %v err %v", records, problems, err)
	}
	if records[0].Slot != 2 || records[0].Version != FormatVersion || !records[0].Stale(42) || records[0].Stale(41) {
		t.Fatalf("record %+v", records[0])
	}
	if err := dir.DeleteRecord(testID); err != nil {
		t.Fatal(err)
	}
	if err := dir.DeleteRecord(testID); err != nil {
		t.Fatal("deleting a missing record is not an error")
	}
}

func TestHeartbeatFreshness(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := dir.WriteHeartbeat(Heartbeat{NowNs: int64(10 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	heartbeat, err := dir.ReadHeartbeat()
	if err != nil {
		t.Fatal(err)
	}
	if !heartbeat.Fresh(10*time.Second+HeartbeatMaxAge) || heartbeat.Fresh(10*time.Second+HeartbeatMaxAge+1) || heartbeat.Fresh(9*time.Second) {
		t.Fatal("heartbeat freshness window is wrong")
	}
}

func TestCgroupPathValidationAndCandidates(t *testing.T) {
	root := "/sys/fs/cgroup"
	valid := []string{
		root + "/system.slice/docker-" + testID + ".scope",
		root + "/docker/" + testID,
		root + "/pids/docker/" + testID,
		root + "/custom.slice/gateway-" + testID + ".scope",
	}
	for _, path := range valid {
		if !ValidCgroupPath(root, testID, path) {
			t.Errorf("%s should be valid", path)
		}
	}
	invalid := []string{
		"", "relative/" + testID, "/etc/" + testID, root, root + "/system.slice/sshd.service",
		root + "/docker/" + testID + "/../../system.slice", root + "/docker/other",
	}
	for _, path := range invalid {
		if ValidCgroupPath(root, testID, path) {
			t.Errorf("%s must be rejected", path)
		}
	}
	candidates := CgroupCandidates(root, testID, root+"/system.slice/sshd.service")
	for _, path := range candidates {
		if !ValidCgroupPath(root, testID, path) {
			t.Fatalf("candidate %s is not a path of the container", path)
		}
	}
	if CgroupCandidates(root, "bad", "") != nil {
		t.Fatal("invalid container ids have no candidates")
	}
}

func TestCgroupFromProcAndEmptiness(t *testing.T) {
	root := t.TempDir()
	v2 := "0::/system.slice/docker-" + testID + ".scope\n"
	if got := CgroupFromProc(root, v2); got != filepath.Join(root, "system.slice", "docker-"+testID+".scope") {
		t.Fatalf("v2 path %s", got)
	}
	v1 := "12:pids:/docker/" + testID + "\n11:memory:/docker/" + testID + "\n1:name=systemd:/docker/" + testID + "\n"
	if got := CgroupFromProc(root, v1); got != filepath.Join(root, "pids", "docker", testID) {
		t.Fatalf("v1 path %s", got)
	}
	empty, err := ContainerCgroupEmpty(root, testID, "")
	if err != nil || !empty {
		t.Fatalf("missing cgroup is empty: %v %v", empty, err)
	}
	scope := filepath.Join(root, "system.slice", "docker-"+testID+".scope")
	child := filepath.Join(scope, "init")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scope, "cgroup.procs"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "cgroup.procs"), []byte("77\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if empty, _ := ContainerCgroupEmpty(root, testID, ""); empty {
		t.Fatal("a process in a child cgroup keeps the container cgroup non-empty")
	}
}
