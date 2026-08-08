package docker

import (
	"errors"
	"github.com/moby/moby/api/types/container"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validManagedDatabaseInput() managedDatabaseCommand {
	return managedDatabaseCommand{
		Type:             "postgres",
		Image:            "docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d",
		StorageSizeBytes: minimumDatabaseBytes,
		MemoryBytes:      1024 * 1024 * 1024,
		OperationID:      "operation_123",
		OwnerUsername:    "app_owner",
		OwnerPassword:    "a-long-random-secret-password",
		DatabaseName:     "app_database",
	}
}

func TestValidateManagedDatabaseInputRejectsMutableOrForeignImages(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Image = "postgres:17.5"
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected mutable image tag to be rejected")
	}
	input.Image = "docker.io/example/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d"
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected non-curated repository to be rejected")
	}
}

func TestValidateManagedDatabaseInputAcceptsEachCuratedEngineVersion(t *testing.T) {
	for engine, images := range curatedManagedDatabaseImages {
		for image := range images {
			t.Run(engine+"/"+image, func(t *testing.T) {
				input := validManagedDatabaseInput()
				input.Type = engine
				input.Image = image
				if engine == "redis" {
					input.OwnerUsername = "default"
				}
				if err := validateManagedDatabaseInput(input); err != nil {
					t.Fatalf("expected curated image to be accepted: %v", err)
				}
			})
		}
	}
}

func TestValidateManagedDatabaseInputRejectsUnsafeClickHouseOverrides(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.Image = "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"
	input.ClickhouseConfig = "<clickhouse><listen_host>0.0.0.0</listen_host></clickhouse>"
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected managed listen_host override to be rejected")
	}
}

func TestValidateManagedDatabaseInputAcceptsSafeClickHouseFragment(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.Image = "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"
	input.ClickhouseConfig = "<clickhouse><max_server_memory_usage>1024</max_server_memory_usage></clickhouse>"
	if err := validateManagedDatabaseInput(input); err != nil {
		t.Fatalf("expected safe config to be accepted: %v", err)
	}
}

func TestManagedDatabaseRequiresRecreateWhenClickHouseConfigChanges(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.ClickhouseConfig = "<clickhouse><max_threads>4</max_threads></clickhouse>"
	record := managedDatabaseRecord{
		Type:                            "clickhouse",
		ClickhouseConfigHash:            clickHouseConfigHash(input.ClickhouseConfig),
		ClickhouseRuntimeProfileVersion: clickHouseRuntimeProfileVersion,
	}

	if managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected unchanged ClickHouse config to keep the existing container")
	}
	input.ClickhouseConfig = "<clickhouse><max_threads>8</max_threads></clickhouse>"
	if !managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected changed ClickHouse config to recreate the container")
	}
}

func TestManagedDatabaseRecreatesLegacyClickHouseForRuntimeProfile(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.Image = "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"
	record := managedDatabaseRecord{Type: "clickhouse"}

	if !managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected legacy ClickHouse container to receive the managed runtime profile")
	}
}

func TestRedisUsesDedicatedDataDirectory(t *testing.T) {
	mountPath := t.TempDir()
	dataPath, err := prepareManagedDatabaseDataSource(
		managedDatabaseRecord{Type: "redis", MountPath: mountPath},
		"redis",
	)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			t.Skip("dedicated Redis ownership requires the root daemon account")
		}
		t.Fatalf("prepare dedicated Redis data source: %v", err)
	}
	if dataPath != filepath.Join(mountPath, "redis-data") {
		t.Fatalf("expected dedicated Redis data path, got %q", dataPath)
	}
	if info, err := os.Stat(dataPath); err != nil || !info.IsDir() {
		t.Fatalf("expected dedicated Redis data directory: %v", err)
	}
}

func TestClickHouseRuntimeProfileDisablesInternalLogTables(t *testing.T) {
	for _, setting := range []string{
		`<logger replace="replace">`,
		`<background_pool_size>16</background_pool_size>`,
		`<background_schedule_pool_size>8</background_schedule_pool_size>`,
		`<trace_log remove="remove"/>`,
		`<metric_log remove="remove"/>`,
		`<asynchronous_metric_log remove="remove"/>`,
		`<background_schedule_pool_log remove="remove"/>`,
		`<error_log remove="remove"/>`,
	} {
		if !strings.Contains(clickHouseRuntimeConfig, setting) {
			t.Fatalf("expected managed ClickHouse runtime config to contain %q", setting)
		}
	}
}

func TestWriteClickHouseConfigConvergesReadableMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.xml")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeClickHouseConfig(path, "new"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("expected ClickHouse config mode 0644, got %o", info.Mode().Perm())
	}
}

func TestValidateManagedDatabaseInputRequiresClickHouseMemoryFloor(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.Image = "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"
	input.MemoryBytes = minimumClickHouseBytes - 1
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected ClickHouse memory floor to be enforced")
	}
	input.MemoryBytes = minimumClickHouseBytes
	if err := validateManagedDatabaseInput(input); err != nil {
		t.Fatalf("expected ClickHouse memory floor to be accepted: %v", err)
	}
}

func TestValidateManagedDatabaseInputRequiresRedisDefaultOwner(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "redis"
	input.Image = "docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236"
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected custom Redis owner username to be rejected")
	}
	input.OwnerUsername = "default"
	if err := validateManagedDatabaseInput(input); err != nil {
		t.Fatalf("expected Redis default owner username to be accepted: %v", err)
	}
}

func TestManagedRedisConfigUsesSafeDefaults(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "redis"
	input.OwnerUsername = "default"
	input.MemoryBytes = 1024 * 1024 * 1024
	config := managedRedisConfigText(input)
	for _, expected := range []string{
		"maxmemory 805306368",
		"maxmemory-policy noeviction",
		"appendonly yes",
		"appendfsync everysec",
		"save 3600 1",
		"activedefrag no",
	} {
		if !strings.Contains(config, expected) {
			t.Fatalf("expected generated Redis config to contain %q", expected)
		}
	}
}

func TestManagedRedisConfigChangeOrMemoryChangeRequiresRecreate(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "redis"
	input.OwnerUsername = "default"
	record := managedDatabaseRecord{Type: "redis", RedisConfigHash: managedRedisConfigHash(input)}
	if managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected unchanged Redis config to keep the existing container")
	}
	input.MemoryBytes *= 2
	if !managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected memory-derived maxmemory change to recreate Redis")
	}
	record.RedisConfigHash = managedRedisConfigHash(input)
	config := defaultManagedRedisConfig()
	config.MaxmemoryPolicy = "allkeys-lru"
	input.RedisConfig = &config
	if !managedDatabaseRequiresRecreate(record, input) {
		t.Fatal("expected changed Redis settings to recreate Redis")
	}
}

func TestValidateManagedRedisConfigRejectsInvalidValues(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "redis"
	input.OwnerUsername = "default"
	config := defaultManagedRedisConfig()
	config.MaxmemoryPercent = 100
	input.RedisConfig = &config
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected invalid Redis maxmemory percentage to be rejected")
	}
	config = defaultManagedRedisConfig()
	config.MaxmemoryPolicy = "unsafe-policy"
	input.RedisConfig = &config
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected invalid Redis eviction policy to be rejected")
	}
}

func TestValidateManagedDatabaseInputRequiresNativeClickHousePublication(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	input.Image = "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5"
	input.PublishTCP = true
	input.PublishedNativePort = 9000
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected native port to require native TCP publication")
	}
	input.PublishNativeTCP = true
	if err := validateManagedDatabaseInput(input); err != nil {
		t.Fatalf("expected explicitly published native ClickHouse port to be accepted: %v", err)
	}
}

func TestValidateManagedDatabaseInputRequiresCompleteTLSMaterial(t *testing.T) {
	input := validManagedDatabaseInput()
	input.TLSEnabled = true
	input.TLSCertificateID = "certificate_123"
	if err := validateManagedDatabaseInput(input); err == nil {
		t.Fatal("expected TLS without certificate material to be rejected")
	}
}

func TestPostgresEngineEnvironmentUsesChildPGDATA(t *testing.T) {
	env := engineEnvironment(validManagedDatabaseInput())
	if !strings.Contains(strings.Join(env, "\n"), "PGDATA=/var/lib/postgresql/data/pgdata") {
		t.Fatal("PostgreSQL must initialize below the ext4 mount root, not beside lost+found")
	}
}

func TestManagedPostgresTLSHBARejectsPlainTCP(t *testing.T) {
	config := managedPostgresTLSHBA
	if strings.Contains(config, "\nhost ") {
		t.Fatalf("PostgreSQL TLS HBA must not admit plaintext TCP: %q", config)
	}
	for _, rule := range []string{
		"local all all trust",
		"hostssl all all 0.0.0.0/0 scram-sha-256",
		"hostssl all all ::0/0 scram-sha-256",
	} {
		if !strings.Contains(config, rule) {
			t.Fatalf("PostgreSQL TLS HBA missing rule %q: %q", rule, config)
		}
	}

	record := managedDatabaseRecord{MountPath: t.TempDir()}
	path := managedPostgresTLSHBAPath(record)
	if err := writeManagedPostgresTLSHBA(path); err != nil {
		t.Fatalf("write PostgreSQL TLS HBA: %v", err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read PostgreSQL TLS HBA: %v", err)
	}
	if string(written) != config {
		t.Fatalf("unexpected PostgreSQL TLS HBA content: %q", written)
	}
}

func TestClickHouseOwnerCanManageBindingPrincipals(t *testing.T) {
	input := validManagedDatabaseInput()
	input.Type = "clickhouse"
	env := strings.Join(engineEnvironment(input), "\n")
	if !strings.Contains(env, "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1") {
		t.Fatal("ClickHouse owner must be allowed to create and revoke managed binding principals")
	}
}

func TestManagedDatabaseTLSPortsMatchEngineProtocols(t *testing.T) {
	if _, port := engineDataPathAndPort("postgres", true); port != "5432/tcp" {
		t.Fatalf("unexpected PostgreSQL TLS port: %s", port)
	}
	if _, port := engineDataPathAndPort("redis", true); port != "6380/tcp" {
		t.Fatalf("unexpected Redis TLS port: %s", port)
	}
	if _, port := engineDataPathAndPort("clickhouse", true); port != "8443/tcp" {
		t.Fatalf("unexpected ClickHouse HTTPS port: %s", port)
	}
	if port := clickHouseNativePort(true); port != "9440/tcp" {
		t.Fatalf("unexpected ClickHouse secure native port: %s", port)
	}
	if port := clickHouseNativePort(false); port != "9000/tcp" {
		t.Fatalf("unexpected ClickHouse plain native port: %s", port)
	}
}

func TestManagedDatabaseTLSOwnerIsPinnedToCuratedEngineUsers(t *testing.T) {
	tests := []struct {
		engine  string
		wantUID int
		wantGID int
	}{
		{"postgres", 999, 999},
		{"redis", 999, 999},
		{"clickhouse", 101, 101},
	}
	for _, test := range tests {
		t.Run(test.engine, func(t *testing.T) {
			uid, gid, err := managedDatabaseTLSOwner(test.engine)
			if err != nil || uid != test.wantUID || gid != test.wantGID {
				t.Fatalf("got uid=%d gid=%d err=%v", uid, gid, err)
			}
		})
	}
	if _, _, err := managedDatabaseTLSOwner("unknown"); err == nil {
		t.Fatal("expected unknown engine TLS owner to be rejected")
	}
}

func TestManagedDatabaseContainerStatusDistinguishesPausedContainers(t *testing.T) {
	if got := managedDatabaseContainerStatus(&container.State{Running: true, Paused: true}); got != "paused" {
		t.Fatalf("expected paused state, got %q", got)
	}
	if got := managedDatabaseContainerStatus(&container.State{Running: true}); got != "ready" {
		t.Fatalf("expected ready state, got %q", got)
	}
	if got := managedDatabaseContainerStatus(&container.State{}); got != "stopped" {
		t.Fatalf("expected stopped state, got %q", got)
	}
}

func TestManagedDatabaseReadinessCommandsUseEngineClientsAndSecretEnvironment(t *testing.T) {
	tests := []struct {
		name          string
		engine        string
		image         string
		ownerUsername string
		wantCommand   []string
		wantEnv       string
	}{
		{
			name:          "Postgres",
			engine:        "postgres",
			image:         "docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d",
			ownerUsername: "app_owner",
			wantCommand:   []string{"pg_isready", "-h", "127.0.0.1"},
			wantEnv:       "PGPASSWORD=",
		},
		{
			name:          "Redis",
			engine:        "redis",
			image:         "docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236",
			ownerUsername: "default",
			wantCommand:   []string{"redis-cli", "PING"},
			wantEnv:       "REDISCLI_AUTH=",
		},
		{
			name:          "ClickHouse",
			engine:        "clickhouse",
			image:         "docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5",
			ownerUsername: "app_owner",
			wantCommand:   []string{"clickhouse-client", "SELECT 1"},
			wantEnv:       "CLICKHOUSE_PASSWORD=",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validManagedDatabaseInput()
			input.Type = test.engine
			input.Image = test.image
			input.OwnerUsername = test.ownerUsername

			command, env, err := managedDatabaseReadinessCommand(input)
			if err != nil {
				t.Fatalf("build readiness command: %v", err)
			}
			joinedCommand := strings.Join(command, " ")
			for _, expected := range test.wantCommand {
				if !strings.Contains(joinedCommand, expected) {
					t.Fatalf("readiness command %q is missing %q", joinedCommand, expected)
				}
			}
			if strings.Contains(joinedCommand, input.OwnerPassword) {
				t.Fatal("readiness command must not include the owner password")
			}
			if !strings.Contains(strings.Join(env, "\n"), test.wantEnv+input.OwnerPassword) {
				t.Fatalf("readiness environment must include %q", test.wantEnv)
			}
		})
	}
}

func TestRefreshDatabaseLoopDeviceCapacityUsesLosetupCapacityRefresh(t *testing.T) {
	binDir := t.TempDir()
	argsPath := filepath.Join(t.TempDir(), "losetup-args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOSETUP_ARGS\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "losetup"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	t.Setenv("LOSETUP_ARGS", argsPath)

	if err := refreshDatabaseLoopDeviceCapacity(t.Context(), "/dev/loop7"); err != nil {
		t.Fatalf("refresh loop device capacity: %v", err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(args) != "-c\n/dev/loop7\n" {
		t.Fatalf("unexpected losetup arguments: %q", args)
	}
}

func TestAttachDatabaseLoopDeviceIgnoresSuccessfulLosetupWarnings(t *testing.T) {
	binDir := t.TempDir()
	script := "#!/bin/sh\nprintf '/dev/loop7\\n'\nprintf 'losetup: image does not end on a 512-byte sector boundary\\n' >&2\n"
	if err := os.WriteFile(filepath.Join(binDir, "losetup"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	loopDevice, err := attachDatabaseLoopDevice(t.Context(), "/var/lib/gateway/database.img")
	if err != nil {
		t.Fatalf("attach loop device: %v", err)
	}
	if loopDevice != "/dev/loop7" {
		t.Fatalf("expected loop device only, got %q", loopDevice)
	}
}

func TestValidateManagedDatabaseBindingInputRejectsUnsafeValues(t *testing.T) {
	input := managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "a-long-random-secret-password",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "another-long-owner-secret",
	}
	if err := validateManagedDatabaseBindingInput(input); err != nil {
		t.Fatalf("expected valid binding input: %v", err)
	}
	input.Username = "unsafe-user"
	if err := validateManagedDatabaseBindingInput(input); err == nil {
		t.Fatal("expected unsafe username to be rejected")
	}
}

func TestBindingPrincipalSQLUsesRealLineTermination(t *testing.T) {
	input := managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "a-long-random-secret-password",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "another-long-owner-secret",
	}
	for name, sql := range map[string]string{
		"postgres create":   postgresBindingCreateSQL(input),
		"postgres remove":   postgresBindingRemoveSQL(input),
		"clickhouse create": clickHouseBindingCreateSQL(input),
		"clickhouse remove": clickHouseBindingRemoveSQL(input),
	} {
		t.Run(name, func(t *testing.T) {
			if !strings.HasSuffix(sql, "\n") {
				t.Fatal("SQL stdin must end with a real newline")
			}
			if strings.Contains(sql, `\n`) {
				t.Fatal("SQL stdin must not contain a literal backslash-n command")
			}
		})
	}
}

func TestClickHouseBindingPrincipalUpdatesExistingPassword(t *testing.T) {
	sql := clickHouseBindingCreateSQL(managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "replacement-long-random-secret",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "owner-secret",
	})
	if !strings.Contains(sql, `ALTER USER "app_user" IDENTIFIED WITH sha256_password BY 'replacement-long-random-secret'`) {
		t.Fatalf("ClickHouse binding SQL must update the password of an existing principal: %q", sql)
	}
}

func TestClickHouseBindingPrincipalGrantsMonitoringViews(t *testing.T) {
	sql := clickHouseBindingCreateSQL(managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "replacement-long-random-secret",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "owner-secret",
	})
	for _, table := range []string{"parts", "merges", "mutations", "events", "disks"} {
		grant := `GRANT SELECT ON system.` + table + ` TO "app_user"`
		if !strings.Contains(sql, grant) {
			t.Fatalf("ClickHouse binding SQL must grant monitoring view %s: %q", table, sql)
		}
	}
	if !strings.Contains(sql, `REVOKE SELECT ON system.processes FROM "app_user"`) {
		t.Fatalf("ClickHouse binding SQL must revoke broad live-query access: %q", sql)
	}
	if !strings.Contains(sql, `GRANT SELECT(memory_usage) ON system.processes TO "app_user"`) {
		t.Fatalf("ClickHouse binding SQL must preserve process memory monitoring: %q", sql)
	}
	if strings.Contains(sql, `GRANT SELECT ON system.processes TO "app_user"`) {
		t.Fatalf("ClickHouse binding SQL must not grant live query text access: %q", sql)
	}
}

func TestClickHouseReaderPrincipalExcludesLiveQueryText(t *testing.T) {
	sql := clickHousePrincipalSQL(clickHousePrincipalCommand{
		PrincipalType: "reader",
		Username:      "query_reader",
		Password:      "replacement-long-random-secret",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "owner-secret",
	})
	for _, expected := range []string{
		`REVOKE ALL ON *.* FROM "query_reader"`,
		`GRANT SELECT ON "app_database".* TO "query_reader"`,
		`GRANT SELECT(name) ON system.databases TO "query_reader"`,
		`GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO "query_reader"`,
		`GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO "query_reader"`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("reader principal SQL must contain %q: %q", expected, sql)
		}
	}
	if strings.Contains(sql, "system.processes") || strings.Contains(sql, "GRANT ALL") {
		t.Fatalf("reader principal must not receive process or broad privileges: %q", sql)
	}
}

func TestClickHouseWriterPrincipalRevokesLegacyLiveQueryAccess(t *testing.T) {
	sql := clickHousePrincipalSQL(clickHousePrincipalCommand{
		PrincipalType: "writer",
		Username:      "query_writer",
		Password:      "replacement-long-random-secret",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "owner-secret",
	})
	for _, expected := range []string{
		`REVOKE ALL ON *.* FROM "query_writer"`,
		`GRANT ALL ON "app_database".* TO "query_writer"`,
		`REVOKE SELECT ON system.processes FROM "query_writer"`,
		`GRANT SELECT(memory_usage) ON system.processes TO "query_writer"`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("writer principal SQL must contain %q: %q", expected, sql)
		}
	}
	if strings.Contains(sql, `GRANT SELECT ON system.processes TO "query_writer"`) {
		t.Fatalf("writer principal must not receive live query text access: %q", sql)
	}
}

func TestValidateClickHousePrincipalInputRejectsUnsafeValues(t *testing.T) {
	input := clickHousePrincipalCommand{
		PrincipalType: "reader",
		Username:      "query_reader",
		Password:      "a-long-random-secret-password",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "another-long-owner-secret",
	}
	if err := validateClickHousePrincipalInput(input); err != nil {
		t.Fatalf("expected valid ClickHouse principal input: %v", err)
	}
	input.PrincipalType = "owner"
	if err := validateClickHousePrincipalInput(input); err == nil {
		t.Fatal("expected unsupported principal type to be rejected")
	}
}

func TestClickHouseBindingProcessPrivilegesReconcileWithoutPasswordMutation(t *testing.T) {
	sql := clickHouseBindingProcessPrivilegesSQL("app_user")
	if strings.Contains(sql, "IDENTIFIED") || strings.Contains(sql, "CREATE USER") || strings.Contains(sql, "ALTER USER") {
		t.Fatalf("ClickHouse process privilege reconciliation must not mutate credentials: %q", sql)
	}
	if !strings.Contains(sql, `REVOKE SELECT ON system.processes FROM "app_user"`) {
		t.Fatalf("ClickHouse process privilege reconciliation must remove broad access: %q", sql)
	}
	if !strings.Contains(sql, `GRANT SELECT(memory_usage) ON system.processes TO "app_user"`) {
		t.Fatalf("ClickHouse process privilege reconciliation must retain memory monitoring: %q", sql)
	}
}

func TestRedisBindingACLCannotAdministerTheServer(t *testing.T) {
	command := redisBindingACLCommand()
	for _, allowed := range []string{"'+@read'", "'+@write'", "'+@connection'", "'+@transaction'", "'+@pubsub'", "'+eval'", "'+evalsha'", "'+script|load'", "'-script|flush'", "'-@dangerous'"} {
		if !strings.Contains(command, allowed) {
			t.Fatalf("Redis binding ACL must include %s", allowed)
		}
	}
	for _, modern := range []string{"'+eval_ro'", "'+evalsha_ro'", "'+fcall'", "'+fcall_ro'", "'-function'"} {
		if !strings.Contains(command, modern) {
			t.Fatalf("Redis 7+ binding ACL must include %s", modern)
		}
	}
	if !strings.Contains(command, "redis_version:") || !strings.Contains(command, "[7-9]|[1-9][0-9]*") {
		t.Fatal("Redis binding ACL must detect Redis 7+ before granting Redis-7-only commands")
	}
	if strings.Contains(command, "+@all") || strings.Contains(command, "+@admin") || strings.Contains(command, "+@scripting") {
		t.Fatal("Redis binding ACL must not grant all, administrative, or scripting command categories")
	}
}

func TestRedisBindingACLRulesKeepRedis62Compatible(t *testing.T) {
	for _, unsupported := range []string{"+eval_ro", "+evalsha_ro", "+fcall", "+fcall_ro", "-function"} {
		for _, baseRule := range redisBindingACLBaseRules() {
			if baseRule == unsupported {
				t.Fatalf("Redis 6.2 base ACL must not include Redis-7-only rule %s", unsupported)
			}
		}
	}
	if len(redisBindingACLModernRules()) != 5 {
		t.Fatalf("expected all Redis-7-only ACL rules to be gated, got %v", redisBindingACLModernRules())
	}
}

func TestManagedDatabaseSwapLimitUsesTheAdditionalSwapBudget(t *testing.T) {
	if got := managedDatabaseSwapLimit(&container.HostConfig{Resources: container.Resources{Memory: 1024, MemorySwap: 3072}}); got != 2048 {
		t.Fatalf("expected 2048-byte swap budget, got %d", got)
	}
	if got := managedDatabaseSwapLimit(&container.HostConfig{Resources: container.Resources{Memory: 1024, MemorySwap: 1024}}); got != 0 {
		t.Fatalf("expected no swap budget, got %d", got)
	}
	if got := managedDatabaseSwapLimit(&container.HostConfig{Resources: container.Resources{Memory: 1024, MemorySwap: -1}}); got != -1 {
		t.Fatalf("expected unlimited swap budget, got %d", got)
	}
}
