package docker

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestVolumeInspectVerifiesDiskImageAgainstRecord(t *testing.T) {
	manager := &volumeImageManager{root: t.TempDir()}
	if err := os.MkdirAll(filepath.Join(manager.root, "records"), 0700); err != nil {
		t.Fatal(err)
	}
	record := manager.newRecord("data", minimumVolumeImageBytes)
	// Renaming retains the original backing paths.
	record.Name = "renamed"
	record.LoopDevice = "/dev/loop2" // Stale metadata must not be used as live evidence.
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	for name, script := range map[string]string{
		"findmnt": `#!/bin/sh
[ "$1" = "-n" ] && [ "$2" = "-o" ] && [ "$3" = "SOURCE" ] && [ "$4" = "--types" ] && [ "$5" = "ext4" ] && [ "$6" = "--mountpoint" ] && [ "$7" = "$EXPECTED_MOUNT" ] || exit 2
[ "$FINDMNT_FAIL" != "1" ] || exit 1
printf '%s\n' "$FINDMNT_SOURCE"
`,
		"losetup": `#!/bin/sh
[ "$1" = "--list" ] && [ "$2" = "--noheadings" ] && [ "$3" = "--output" ] && [ "$4" = "NAME" ] && [ "$5" = "--associated" ] && [ "$6" = "$EXPECTED_IMAGE" ] || exit 2
[ "$LOSETUP_FAIL" != "1" ] || exit 1
printf '%s\n' "$LOSETUP_DEVICES"
`,
	} {
		if err := os.WriteFile(filepath.Join(binDir, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	t.Setenv("EXPECTED_MOUNT", record.MountPath)
	t.Setenv("EXPECTED_IMAGE", record.ImagePath)
	valid := func() volume.Volume {
		return volume.Volume{Name: record.Name, Driver: "local", Scope: "local",
			Labels:  volumeImageLabels(record.CapacityBytes),
			Options: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"}}
	}
	for _, tc := range []struct {
		name    string
		change  func(*volume.Volume)
		manager *volumeImageManager
		want    bool
		env     map[string]string
	}{
		{name: "renamed disk image", manager: manager, want: true},
		{name: "host path substitution", manager: manager, change: func(v *volume.Volume) { v.Options["device"] = "/etc" }},
		{name: "extra option", manager: manager, change: func(v *volume.Volume) { v.Options["extra"] = "value" }},
		{name: "changed mount mode", manager: manager, change: func(v *volume.Volume) { v.Options["o"] = "rbind" }},
		{name: "changed filesystem", manager: manager, change: func(v *volume.Volume) { v.Options["type"] = "nfs" }},
		{name: "missing record", manager: manager, change: func(v *volume.Volume) { v.Name = "unknown" }},
		{name: "missing labels", manager: manager, change: func(v *volume.Volume) { v.Labels = nil }},
		{name: "wrong driver", manager: manager, change: func(v *volume.Volume) { v.Driver = "nfs" }},
		{name: "wrong scope", manager: manager, change: func(v *volume.Volume) { v.Scope = "global" }},
		{name: "no manager"},
		{name: "unmounted image", manager: manager, env: map[string]string{"FINDMNT_FAIL": "1"}},
		{name: "host filesystem", manager: manager, env: map[string]string{"FINDMNT_SOURCE": "/dev/sda1"}},
		{name: "wrong image backing loop device", manager: manager, env: map[string]string{"LOSETUP_DEVICES": "/dev/loop2"}},
		{name: "missing backing association", manager: manager, env: map[string]string{"LOSETUP_DEVICES": ""}},
		{name: "backing lookup failed", manager: manager, env: map[string]string{"LOSETUP_FAIL": "1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("FINDMNT_SOURCE", "/dev/loop7")
			t.Setenv("FINDMNT_FAIL", "0")
			t.Setenv("LOSETUP_DEVICES", "/dev/loop7")
			t.Setenv("LOSETUP_FAIL", "0")
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			inspected := valid()
			if tc.change != nil {
				tc.change(&inspected)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "/containers/json") {
					_, _ = w.Write([]byte("[]"))
					return
				}
				_ = json.NewEncoder(w).Encode(inspected)
			}))
			defer server.Close()
			dockerAPI, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
			if err != nil {
				t.Fatal(err)
			}
			defer dockerAPI.Close()
			plugin := &DockerPlugin{client: &Client{cli: dockerAPI, logger: slog.Default()}, volumeImages: tc.manager}
			result := &pb.CommandResult{Success: true}
			plugin.handleVolumeCommand(&pb.DockerVolumeCommand{Action: "inspect", Name: inspected.Name}, result)
			if !result.Success {
				t.Fatalf("inspect failed: %s", result.Error)
			}
			var response struct {
				volume.Volume
				ManagedDiskImage bool
			}
			if err := json.Unmarshal([]byte(result.Detail), &response); err != nil {
				t.Fatal(err)
			}
			if response.ManagedDiskImage != tc.want {
				t.Fatalf("verified = %v, want %v", response.ManagedDiskImage, tc.want)
			}
			if response.Name != inspected.Name || response.Options["device"] != inspected.Options["device"] {
				t.Fatal("inspection lost the Docker volume definition")
			}
		})
	}
}

func TestRegularVolumeMetricsUseDockerUsageAndRunningAttachments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/json"):
			_, _ = w.Write([]byte(`[
				{"Id":"running-1","State":"running","Mounts":[{"Type":"volume","Name":"data"}]},
				{"Id":"running-2","State":"running","Mounts":[{"Type":"volume","Name":"other"}]}
			]`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/system/df"):
			_, _ = w.Write([]byte(`{"Volumes":[{"Name":"data","Driver":"local","Labels":{},"Mountpoint":"/data","Options":{},"Scope":"local","UsageData":{"RefCount":1,"Size":4096}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dockerAPI, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	defer dockerAPI.Close()
	manager := &volumeImageManager{
		client: &Client{cli: dockerAPI, logger: slog.Default()},
		logger: slog.Default(),
		root:   t.TempDir(),
	}

	metrics, err := manager.metrics(context.Background(), "data")
	if err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	if metrics.StorageKind != volumeStorageKindRegular || metrics.UsedBytes == nil || *metrics.UsedBytes != 4096 {
		t.Fatalf("unexpected regular volume metrics: %+v", metrics)
	}
	if metrics.CapacityBytes != nil || metrics.UsedInodes != nil {
		t.Fatalf("regular volume exposed unsupported capacity/inodes: %+v", metrics)
	}
	if metrics.RunningAttachmentCount != 1 {
		t.Fatalf("running attachments = %d, want 1", metrics.RunningAttachmentCount)
	}
}

func TestVolumeImageRecordPathsStayInsideManagerRoot(t *testing.T) {
	manager := &volumeImageManager{root: t.TempDir()}
	record := manager.newRecord("../../data", 1024)
	if !pathWithin(manager.root, record.ImagePath) || !pathWithin(manager.root, record.MountPath) {
		t.Fatalf("record paths escaped manager root: %+v", record)
	}
	if pathWithin(manager.root, manager.root+"-other/file") {
		t.Fatal("sibling path was accepted as inside root")
	}
}

func TestVolumeImageFstabEntryEscapesPaths(t *testing.T) {
	record := volumeImageRecord{ImagePath: `/var/lib/gateway images/data\\one.img`, MountPath: "/var/lib/gateway\tmount"}
	entry := volumeImageFstabEntryLine(record)
	if strings.Contains(entry, "gateway images") || strings.Contains(entry, "gateway\tmount") {
		t.Fatalf("fstab entry contains unescaped whitespace: %q", entry)
	}
	if !strings.Contains(entry, `gateway\040images`) || !strings.Contains(entry, `gateway\011mount`) {
		t.Fatalf("fstab entry did not contain expected escapes: %q", entry)
	}
}
