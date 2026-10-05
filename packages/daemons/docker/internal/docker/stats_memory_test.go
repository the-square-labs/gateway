package docker

import (
	"encoding/json"
	"testing"

	"github.com/moby/moby/api/types/container"
)

// memory_stats blocks as the Docker Engine API returns them.
const (
	// cgroup v2: a Postgres container whose usage is mostly file cache.
	memoryStatsV2 = `{"usage":445644800,"limit":536870912,"stats":{"active_file":24576000,"anon":101068800,"file":338784256,"inactive_file":319823872,"shmem":0}}`
	// cgroup v1 with hierarchy totals.
	memoryStatsV1 = `{"usage":209715200,"max_usage":262144000,"limit":2147483648,"stats":{"cache":125829120,"rss":73400320,"total_cache":125829120,"total_inactive_file":104857600,"total_rss":73400320}}`
	// Older cgroup v1 daemons that report only cache.
	memoryStatsV1CacheOnly = `{"usage":104857600,"limit":2147483648,"stats":{"cache":41943040}}`
)

func decodeMemoryStats(t *testing.T, raw string) container.MemoryStats {
	t.Helper()
	var mem container.MemoryStats
	if err := json.Unmarshal([]byte(raw), &mem); err != nil {
		t.Fatal(err)
	}
	return mem
}

func TestContainerWorkingSetBytesMatchesDockerStats(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want int64
	}{
		{"cgroup v2 subtracts inactive_file", memoryStatsV2, 445644800 - 319823872},
		{"cgroup v1 subtracts total_inactive_file", memoryStatsV1, 209715200 - 104857600},
		{"cgroup v1 falls back to cache", memoryStatsV1CacheOnly, 104857600 - 41943040},
		{"no stats keeps raw usage", `{"usage":5000,"limit":10000}`, 5000},
		{"cache above usage clamps to zero", `{"usage":100,"stats":{"inactive_file":200}}`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := containerWorkingSetBytes(decodeMemoryStats(t, tc.raw)); got != tc.want {
				t.Fatalf("got %d, want %d", got, tc.want)
			}
		})
	}
}

func TestStatsResponseToProtoReportsWorkingSetAndLimit(t *testing.T) {
	stats := &container.StatsResponse{MemoryStats: decodeMemoryStats(t, memoryStatsV2)}
	cs := statsResponseToProto(stats, nil)
	if cs.MemoryUsageBytes != 445644800-319823872 {
		t.Fatalf("usage = %d", cs.MemoryUsageBytes)
	}
	if cs.MemoryLimitBytes != 536870912 {
		t.Fatalf("limit = %d", cs.MemoryLimitBytes)
	}
}
