package sysmetrics

import "testing"

func TestIncludeDiskMountKeepsManagedLoopExt4Mounts(t *testing.T) {
	for _, test := range []struct {
		name       string
		device     string
		mountPoint string
		filesystem string
		want       bool
	}{
		{
			name:       "managed ext4 image on loop device",
			device:     "/dev/loop7",
			mountPoint: "/data/storage/mounts/11111111-1111-4111-8111-111111111111-0",
			filesystem: "ext4",
			want:       true,
		},
		{name: "root overlay", device: "overlay", mountPoint: "/", filesystem: "overlay", want: true},
		{name: "non-root overlay", device: "overlay", mountPoint: "/var/lib/docker", filesystem: "overlay", want: false},
		{name: "temporary filesystem", device: "tmpfs", mountPoint: "/run", filesystem: "tmpfs", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := includeDiskMount(test.device, test.mountPoint, test.filesystem); got != test.want {
				t.Fatalf("includeDiskMount(%q, %q, %q) = %t, want %t", test.device, test.mountPoint, test.filesystem, got, test.want)
			}
		})
	}
}
