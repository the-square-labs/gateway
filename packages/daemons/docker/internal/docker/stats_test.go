package docker

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/moby/moby/api/types/container"
)

func TestCalculateCPUPercentUsesHostTotalWhenUnlimited(t *testing.T) {
	stats := testStatsResponse(100, 400, 4)

	got := calculateCPUPercent(stats, nil)
	want := 25.0
	if math.Abs(got-want) > 0.0001 {
		t.Fatalf("expected %.2f, got %.2f", want, got)
	}
}

func TestStatsMemoryUsesContainerLimit(t *testing.T) {
	stats := testStatsResponse(100, 400, 4)
	stats.MemoryStats.Usage = 64 * 1024 * 1024
	stats.MemoryStats.Limit = 16 * 1024 * 1024 * 1024
	inspect := &container.InspectResponse{HostConfig: &container.HostConfig{
		Resources: container.Resources{Memory: 256 * 1024 * 1024},
	}}
	got := statsResponseToProto(stats, inspect)
	if got.MemoryLimitBytes != 256*1024*1024 || got.MemoryUsageBytes != int64(stats.MemoryStats.Usage) {
		t.Fatalf("expected container memory denominator, got %+v", got)
	}
	stats.MemoryStats.Limit = 128 * 1024 * 1024
	if got := statsResponseToProto(stats, inspect); got.MemoryLimitBytes != 128*1024*1024 {
		t.Fatalf("expected lower effective cgroup limit, got %d", got.MemoryLimitBytes)
	}
	inspect.HostConfig.Memory = 0
	if got := statsResponseToProto(stats, inspect); got.MemoryLimitBytes != int64(stats.MemoryStats.Limit) {
		t.Fatalf("expected Docker stats fallback when unlimited, got %d", got.MemoryLimitBytes)
	}
}

func TestCalculateCPUPercentUsesNanoCpuLimit(t *testing.T) {
	stats := testStatsResponse(100, 400, 4)
	inspect := &container.InspectResponse{
		HostConfig: &container.HostConfig{
			Resources: container.Resources{
				NanoCPUs: 1_000_000_000,
			},
		},
	}

	got := calculateCPUPercent(stats, inspect)
	if got != 100 {
		t.Fatalf("expected 100, got %.2f", got)
	}
}

func TestCalculateCPUPercentUsesCpuQuotaLimit(t *testing.T) {
	stats := testStatsResponse(100, 400, 4)
	inspect := &container.InspectResponse{
		HostConfig: &container.HostConfig{
			Resources: container.Resources{
				CPUQuota:  200000,
				CPUPeriod: 100000,
			},
		},
	}

	got := calculateCPUPercent(stats, inspect)
	want := 50.0
	if math.Abs(got-want) > 0.0001 {
		t.Fatalf("expected %.2f, got %.2f", want, got)
	}
}

func TestCalculateCPUPercentUsesCpuSetLimit(t *testing.T) {
	stats := testStatsResponse(200, 400, 4)
	inspect := &container.InspectResponse{
		HostConfig: &container.HostConfig{
			Resources: container.Resources{
				CpusetCpus: "0-1",
			},
		},
	}

	got := calculateCPUPercent(stats, inspect)
	if got != 100 {
		t.Fatalf("expected 100, got %.2f", got)
	}
}

func TestCalculateCPUPercentCapsAtHundred(t *testing.T) {
	stats := testStatsResponse(900, 400, 4)
	inspect := &container.InspectResponse{
		HostConfig: &container.HostConfig{
			Resources: container.Resources{
				NanoCPUs: 1_000_000_000,
			},
		},
	}

	got := calculateCPUPercent(stats, inspect)
	if got != 100 {
		t.Fatalf("expected 100, got %.2f", got)
	}
}

func TestCountCPUSet(t *testing.T) {
	got := countCPUSet("0-2,4,6-7")
	if got != 6 {
		t.Fatalf("expected 6, got %.2f", got)
	}
}

func testStatsResponse(cpuDelta uint64, systemDelta uint64, onlineCPUs uint32) *container.StatsResponse {
	return &container.StatsResponse{
		CPUStats: container.CPUStats{
			CPUUsage: container.CPUUsage{
				TotalUsage: cpuDelta + 100,
			},
			SystemUsage: systemDelta + 1000,
			OnlineCPUs:  onlineCPUs,
		},
		PreCPUStats: container.CPUStats{
			CPUUsage: container.CPUUsage{
				TotalUsage: 100,
			},
			SystemUsage: 1000,
			OnlineCPUs:  onlineCPUs,
		},
	}
}

func TestContainerLogBytesCountsRotatedFiles(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "abc-json.log")
	for name, size := range map[string]int{"abc-json.log": 100, "abc-json.log.1": 50, "abc-json.log.2.gz": 25, "config.v2.json": 999} {
		if err := os.WriteFile(filepath.Join(directory, name), make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := containerLogBytes(logPath); err != nil || got != 175 {
		t.Fatalf("log bytes = %d, %v; want 175", got, err)
	}
	if _, err := containerLogBytes(filepath.Join(directory, "missing", "x-json.log")); err == nil {
		t.Fatal("an unreadable log directory must be reported")
	}
	if got, err := containerLogBytes(""); err != nil || got != 0 {
		t.Fatalf("no log path = %d, %v; want 0 without error", got, err)
	}
}
