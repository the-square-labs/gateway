package docker

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

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
