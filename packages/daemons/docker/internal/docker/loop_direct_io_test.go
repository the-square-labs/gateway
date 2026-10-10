package docker

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestEnsureDirectIOSwitchesTheMountedDeviceAndAsksOnceAfterARefusal(t *testing.T) {
	mountPath := canonicalLoopPath(filepath.Join(t.TempDir(), "mount"))
	var calls []string
	refuse := false
	host := &loopHost{
		mounts: func() ([]mountEntry, error) {
			return []mountEntry{{MountPoint: mountPath, Number: "7:5"}}, nil
		},
		loops: func() ([]loopDevice, error) {
			return []loopDevice{{Path: "/dev/loop5", Number: "7:5", BackingFile: "/images/a.img"}}, nil
		},
		directIO: func(_ context.Context, device string) error {
			calls = append(calls, device)
			if refuse {
				return errors.New("LOOP_SET_DIRECT_IO: invalid argument")
			}
			return nil
		},
	}
	ctx := context.Background()

	host.ensureDirectIO(ctx, nil, "managed storage", "a", mountPath)
	host.ensureDirectIO(ctx, nil, "managed storage", "a", mountPath)
	if len(calls) != 2 || calls[0] != "/dev/loop5" {
		t.Fatalf("calls = %v, want the mounted device on every pass while it accepts", calls)
	}

	refuse = true
	t.Cleanup(func() { loopDirectIORefused.Delete("/dev/loop5\x00" + mountPath) })
	host.ensureDirectIO(ctx, nil, "managed storage", "a", mountPath)
	host.ensureDirectIO(ctx, nil, "managed storage", "a", mountPath)
	if len(calls) != 3 {
		t.Fatalf("calls = %d, want one more call and none after the refusal", len(calls))
	}

	host.ensureDirectIO(ctx, nil, "managed storage", "b", filepath.Join(t.TempDir(), "not-mounted"))
	if len(calls) != 3 {
		t.Fatalf("calls = %d, want no call for a path without a mounted loop device", len(calls))
	}
}
