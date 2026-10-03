package docker

import (
	"log/slog"
	"testing"
)

// A Redis memory change only moves maxmemory, which a running Redis takes
// without a restart; any other config change still recreates the container.
func TestRedisMemoryChangeIsAppliedInPlace(t *testing.T) {
	m := &managedDatabaseManager{logger: slog.New(slog.DiscardHandler)}
	current := managedDatabaseCommand{Type: "redis", MemoryBytes: 256 << 20, PublishTCP: true, PublishedPort: 32768, TLSEnabled: true}
	record := managedDatabaseRecord{Type: "redis", MountPath: t.TempDir(), PublishedPort: 32768, TLSEnabled: true, RedisConfigHash: managedRedisConfigHash(current)}
	if err := writeManagedRedisConfig(managedRedisBoundConfigPath(record), managedRedisConfigText(current)); err != nil {
		t.Fatal(err)
	}

	resized := current
	resized.MemoryBytes, resized.NanoCPUs = 320<<20, 750_000_000
	if !managedDatabaseRequiresRecreate(record, resized) || managedDatabaseContainerSettingsChanged(record, resized) {
		t.Fatal("a memory change must differ only in the Redis config")
	}
	value, live := m.redisMaxmemoryOnlyChange(record, resized)
	if !live || value != managedRedisMaxmemory(current) {
		t.Fatalf("maxmemory-only change = %v (current %d), want true (%d)", live, value, managedRedisMaxmemory(current))
	}

	// The bound file keeps its name; once rewritten, the next update compares
	// against what it now holds.
	if err := writeManagedRedisConfig(managedRedisBoundConfigPath(record), managedRedisConfigText(resized)); err != nil {
		t.Fatal(err)
	}
	if value, live := m.redisMaxmemoryOnlyChange(record, resized); !live || value != managedRedisMaxmemory(resized) {
		t.Fatalf("after the rewrite: %v (%d)", live, value)
	}

	policy := resized
	policy.RedisConfig = &managedRedisConfig{}
	*policy.RedisConfig = defaultManagedRedisConfig()
	policy.RedisConfig.MaxmemoryPolicy = "allkeys-lru"
	if _, live := m.redisMaxmemoryOnlyChange(record, policy); live {
		t.Fatal("a policy change must recreate the container")
	}
}
