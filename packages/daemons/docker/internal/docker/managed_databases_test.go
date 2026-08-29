package docker

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestPortBindingNeedsPinning(t *testing.T) {
	port, err := network.ParsePort("5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	if !portBindingNeedsPinning(network.PortMap{}, port, 32768) {
		t.Fatal("expected a missing publication to require pinning")
	}
	if !portBindingNeedsPinning(network.PortMap{port: {{HostPort: ""}}}, port, 32768) {
		t.Fatal("expected an auto-assigned Docker publication to require pinning")
	}
	if portBindingNeedsPinning(network.PortMap{port: {{HostPort: "32768"}}}, port, 32768) {
		t.Fatal("expected the recorded explicit publication to remain stable")
	}
	if !portBindingNeedsPinning(network.PortMap{port: {{HostPort: "32769"}}}, port, 32768) {
		t.Fatal("expected a mismatched explicit publication to require reconciliation")
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

func TestClickHouseOwnerOverrideReplacesTheEntrypointPassword(t *testing.T) {
	config := clickHouseOwnerOverrideConfig("clickhouse_owner", `owner-<&-password-123456`)
	if !strings.Contains(config, `<password replace="replace">owner-&lt;&amp;-password-123456</password>`) {
		t.Fatalf("ClickHouse owner override must replace and escape the entrypoint password: %q", config)
	}
	if !strings.Contains(config, "<clickhouse_owner>") || !strings.Contains(config, "<access_management>1</access_management>") {
		t.Fatalf("ClickHouse owner override must preserve the managed access-management user: %q", config)
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

func TestAttachDatabaseLoopDeviceUsesVisibleDelegatedDeviceWhenLoopControlFindIsNotUsable(t *testing.T) {
	binDir := t.TempDir()
	argsPath := filepath.Join(t.TempDir(), "losetup-args")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$LOSETUP_ARGS"
case "$1" in
  -j) exit 0 ;;
  /dev/loop20)
    if [ "$#" -eq 1 ]; then
      printf 'losetup: /dev/loop20: No such file or directory\n' >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "losetup"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	t.Setenv("LOSETUP_ARGS", argsPath)

	loopDevice, err := attachDatabaseLoopDeviceFromCandidates(
		t.Context(),
		"/var/lib/gateway/database.img",
		[]string{"/dev/loop20"},
	)
	if err != nil {
		t.Fatalf("attach delegated loop device: %v", err)
	}
	if loopDevice != "/dev/loop20" {
		t.Fatalf("expected delegated loop device, got %q", loopDevice)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "/dev/loop20 /var/lib/gateway/database.img") {
		t.Fatalf("expected explicit delegated loop attach, got %q", args)
	}
}

func TestAttachDatabaseLoopDeviceReusesVisibleExistingAssociation(t *testing.T) {
	binDir := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = \"-j\" ]; then printf '/dev/loop21: [0000]:1 ($2)\\n'; exit 0; fi\nexit 1\n"
	if err := os.WriteFile(filepath.Join(binDir, "losetup"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	loopDevice, err := attachDatabaseLoopDeviceFromCandidates(
		t.Context(),
		"/var/lib/gateway/database.img",
		[]string{"/dev/loop20", "/dev/loop21"},
	)
	if err != nil {
		t.Fatalf("reuse delegated loop device: %v", err)
	}
	if loopDevice != "/dev/loop21" {
		t.Fatalf("expected existing delegated association, got %q", loopDevice)
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

func TestValidateManagedDatabasePrincipalV2InputRejectsUnsafeValues(t *testing.T) {
	input := managedDatabasePrincipalV2Command{
		OperationID:              "11111111-1111-4111-8111-111111111111",
		PrincipalName:            "gw_b_123",
		Password:                 "a-long-random-secret-password",
		DatabaseName:             "app_database",
		ApplicationPrincipalName: "app_owner",
		OwnerUsername:            "gateway_admin",
		OwnerPassword:            "another-long-owner-secret",
	}
	if err := validateManagedDatabasePrincipalV2Input(input); err != nil {
		t.Fatalf("expected valid identity-v2 input: %v", err)
	}
	input.ApplicationPrincipalName = "unsafe-role"
	if err := validateManagedDatabasePrincipalV2Input(input); err == nil {
		t.Fatal("expected unsafe application role to be rejected")
	}
}

func TestManagedDatabaseRuntimePreparationPreservesLifecycleOperationID(t *testing.T) {
	record := managedDatabaseRecord{OperationID: "11111111-1111-4111-8111-111111111111"}
	applyManagedDatabaseOperationID(&record, managedDatabaseCommand{
		OperationID:                  "binding-identity-database-1",
		PreserveLifecycleOperationID: true,
	})
	if record.OperationID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("identity runtime preparation replaced lifecycle operation ID with %q", record.OperationID)
	}

	applyManagedDatabaseOperationID(&record, managedDatabaseCommand{
		OperationID: "22222222-2222-4222-8222-222222222222",
	})
	if record.OperationID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("ordinary lifecycle update did not advance operation ID: %q", record.OperationID)
	}
}

func TestPostgresBindingPrincipalV2UsesStableApplicationOwner(t *testing.T) {
	input := managedDatabasePrincipalV2Command{
		OperationID:              "11111111-1111-4111-8111-111111111111",
		PrincipalName:            "gw_b_123",
		Password:                 "a-long-random-secret-password",
		DatabaseName:             "app_database",
		ApplicationPrincipalName: "app_owner",
		OwnerUsername:            "gateway_admin",
		OwnerPassword:            "another-long-owner-secret",
	}
	applySQL := postgresBindingPrincipalV2ApplySQL(input)
	for _, expected := range []string{
		`LOGIN NOINHERIT PASSWORD`,
		`GRANT "app_owner" TO "gw_b_123"`,
		`ALTER ROLE "gw_b_123" IN DATABASE "app_database" SET role TO 'app_owner'`,
	} {
		if !strings.Contains(applySQL, expected) {
			t.Fatalf("PostgreSQL identity-v2 apply must contain %q: %q", expected, applySQL)
		}
	}
	dropSQL := postgresBindingPrincipalV2DropSQL(input)
	for _, expected := range []string{"NOLOGIN", "pg_terminate_backend", "REASSIGN OWNED", "DROP OWNED", "DROP ROLE"} {
		if !strings.Contains(dropSQL, expected) {
			t.Fatalf("PostgreSQL identity-v2 drop must contain %q: %q", expected, dropSQL)
		}
	}
}

func TestPostgresOwnerSeparationPreservesLegacyOwnerRole(t *testing.T) {
	input := managedDatabaseOwnerSeparationCommand{
		OperationID:              "11111111-1111-4111-8111-111111111111",
		DatabaseName:             "app_database",
		ApplicationPrincipalName: "gw_app_123",
		CurrentOwnerUsername:     "legacy_owner",
		CurrentOwnerPassword:     "a-long-current-owner-password",
		PendingOwnerUsername:     "gateway_admin",
		PendingOwnerPassword:     "a-long-pending-owner-password",
	}
	sql := postgresOwnerSeparationPrepareSQL(input)
	if !strings.Contains(sql, `CREATE ROLE %I NOLOGIN NOSUPERUSER`) {
		t.Fatalf("owner separation must create a stable application role: %q", sql)
	}
	for _, expected := range []string{
		`CREATE ROLE %I LOGIN SUPERUSER PASSWORD %L`,
		`ALTER DATABASE %I OWNER TO %I`,
		`ALTER ROUTINE %I.%I(%s) OWNER TO %I`,
		`ALTER TYPE %I.%I OWNER TO %I`,
		`ALTER ROLE %I IN DATABASE %I SET role TO %L`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("owner separation must contain %q: %q", expected, sql)
		}
	}
}

func TestPostgresOwnerSeparationLive(t *testing.T) {
	images := strings.TrimSpace(os.Getenv("GATEWAY_POSTGRES_IDENTITY_TEST_IMAGES"))
	if images == "" {
		t.Skip("set GATEWAY_POSTGRES_IDENTITY_TEST_IMAGES to run disposable PostgreSQL identity tests")
	}
	for _, image := range strings.Split(images, ",") {
		image = strings.TrimSpace(image)
		if image == "" {
			continue
		}
		t.Run(strings.ReplaceAll(image, ":", "-"), func(t *testing.T) {
			name := fmt.Sprintf("gateway-pg-identity-%d", time.Now().UnixNano())
			runDockerTestCommand(t, "run", "-d", "--rm", "--name", name,
				"-e", "POSTGRES_USER=legacy_owner",
				"-e", "POSTGRES_PASSWORD=legacy-password-123456",
				"-e", "POSTGRES_DB=app",
				image,
			)
			t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
			deadline := time.Now().Add(30 * time.Second)
			for {
				if exec.Command("docker", "exec", "-e", "PGPASSWORD=legacy-password-123456", name,
					"pg_isready", "-q", "-h", "127.0.0.1", "-U", "legacy_owner", "-d", "app").Run() == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("PostgreSQL did not become ready")
				}
				time.Sleep(250 * time.Millisecond)
			}

			seed := `CREATE SCHEMA app_extra;
CREATE TYPE app_extra.app_status AS ENUM ('ready');
CREATE DOMAIN app_extra.positive_int AS integer CHECK (VALUE > 0);
CREATE TABLE app_extra.existing_table(id app_extra.positive_int, status app_extra.app_status);
CREATE SEQUENCE app_extra.existing_sequence;
CREATE VIEW app_extra.existing_view AS SELECT id FROM app_extra.existing_table;
CREATE MATERIALIZED VIEW app_extra.existing_materialized_view AS SELECT id FROM app_extra.existing_table;
CREATE FUNCTION app_extra.existing_function(value integer) RETURNS integer LANGUAGE sql AS $$ SELECT value + 1 $$;
CREATE PROCEDURE app_extra.existing_procedure() LANGUAGE sql AS $$ SELECT 1 $$;
CREATE STATISTICS app_extra.existing_statistics ON id, status FROM app_extra.existing_table;`
			runPostgresTestSQL(t, name, "legacy_owner", "legacy-password-123456", seed)

			separation := managedDatabaseOwnerSeparationCommand{
				OperationID:              "11111111-1111-4111-8111-111111111111",
				DatabaseName:             "app",
				ApplicationPrincipalName: "gw_app_123",
				CurrentOwnerUsername:     "legacy_owner",
				CurrentOwnerPassword:     "legacy-password-123456",
				PendingOwnerUsername:     "gateway_admin",
				PendingOwnerPassword:     "admin-password-123456",
			}
			runPostgresTestSQL(t, name, "legacy_owner", "legacy-password-123456", postgresOwnerSeparationPrepareSQL(separation))

			binding := managedDatabasePrincipalV2Command{
				OperationID:              "22222222-2222-4222-8222-222222222222",
				PrincipalName:            "gw_b_one",
				Password:                 "binding-password-123456",
				DatabaseName:             "app",
				ApplicationPrincipalName: "gw_app_123",
				OwnerUsername:            "gateway_admin",
				OwnerPassword:            "admin-password-123456",
			}
			runPostgresTestSQL(t, name, "gateway_admin", "admin-password-123456", postgresBindingPrincipalV2ApplySQL(binding))
			runPostgresTestSQL(t, name, "gw_b_one", "binding-password-123456", `ALTER TABLE app_extra.existing_table ADD COLUMN name text;
CREATE OR REPLACE FUNCTION app_extra.existing_function(value integer) RETURNS integer LANGUAGE sql AS $$ SELECT value + 2 $$;
CREATE TABLE app_extra.binding_table(id integer);`)

			owners := runPostgresTestQuery(t, name, "gateway_admin", "admin-password-123456", `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app_extra' AND c.relkind IN ('r','S','v','m') AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname='gw_app_123')`)
			if strings.TrimSpace(owners) != "0" {
				t.Fatalf("expected application relations to have stable owner, got %q", owners)
			}

			runPostgresTestSQL(t, name, "gateway_admin", "admin-password-123456", `ALTER ROLE legacy_owner NOLOGIN PASSWORD NULL;`)
			if exec.Command("docker", "exec", "-e", "PGPASSWORD=legacy-password-123456", name,
				"psql", "-h", "127.0.0.1", "-U", "legacy_owner", "-d", "app", "-c", "SELECT 1").Run() == nil {
				t.Fatal("legacy owner login remained usable after finalization")
			}
		})
	}
}

func runDockerTestCommand(t *testing.T, args ...string) string {
	t.Helper()
	output, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output)
}

func runPostgresTestSQL(t *testing.T, containerName, username, password, sql string) {
	t.Helper()
	command := exec.Command("docker", "exec", "-i", "-e", "PGPASSWORD="+password, containerName,
		"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", username, "-d", "app")
	command.Stdin = strings.NewReader(sql)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("execute PostgreSQL SQL as %s: %v: %s", username, err, strings.TrimSpace(string(output)))
	}
}

func runPostgresTestQuery(t *testing.T, containerName, username, password, sql string) string {
	t.Helper()
	return runDockerTestCommand(t, "exec", "-e", "PGPASSWORD="+password, containerName,
		"psql", "-h", "127.0.0.1", "-U", username, "-d", "app", "-tAc", sql)
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

func TestPostgresBindingPrincipalCanRunSchemaMigrations(t *testing.T) {
	sql := postgresBindingCreateSQL(managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "a-long-random-secret-password",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "another-long-owner-secret",
	})
	if !strings.Contains(sql, `GRANT USAGE, CREATE ON SCHEMA public TO "app_user"`) {
		t.Fatalf("PostgreSQL binding user must be able to create migration tables: %q", sql)
	}
}

func TestPostgresBindingRemovalPreservesOwnedObjectsAndDropsRole(t *testing.T) {
	sql := postgresBindingRemoveSQL(managedDatabaseBindingCommand{
		BindingID:     "binding_123",
		Username:      "app_user",
		Password:      "a-long-random-secret-password",
		DatabaseName:  "app_database",
		OwnerUsername: "app_owner",
		OwnerPassword: "another-long-owner-secret",
	})
	reassign := `REASSIGN OWNED BY ' || quote_ident('app_user') || ' TO ' || quote_ident('app_owner')`
	dropOwned := `DROP OWNED BY ' || quote_ident('app_user')`
	dropRole := `DROP ROLE ' || quote_ident('app_user')`
	for _, statement := range []string{reassign, dropOwned, dropRole} {
		if !strings.Contains(sql, statement) {
			t.Fatalf("PostgreSQL binding removal is missing %q: %q", statement, sql)
		}
	}
	if !(strings.Index(sql, reassign) < strings.Index(sql, dropOwned) && strings.Index(sql, dropOwned) < strings.Index(sql, dropRole)) {
		t.Fatalf("PostgreSQL binding removal must preserve objects before revoking grants and dropping the role: %q", sql)
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
	for _, allowed := range []string{"'+@read'", "'+@write'", "'+@connection'", "'+@transaction'", "'+@pubsub'", "'+eval'", "'+evalsha'", "'-script'", "'-@dangerous'"} {
		if !strings.Contains(command, allowed) {
			t.Fatalf("Redis binding ACL must include %s", allowed)
		}
	}
	for _, modern := range []string{"'+eval_ro'", "'+evalsha_ro'", "'+fcall'", "'+fcall_ro'", "'+script|load'", "'+script|exists'", "'-function'", "'-script|flush'"} {
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
	baseRules := redisBindingACLBaseRules()
	hasScriptDeny := false
	for _, unsupported := range []string{"+eval_ro", "+evalsha_ro", "+fcall", "+fcall_ro", "-function"} {
		for _, baseRule := range baseRules {
			if baseRule == unsupported {
				t.Fatalf("Redis 6.2 base ACL must not include Redis-7-only rule %s", unsupported)
			}
		}
	}
	for _, baseRule := range baseRules {
		if strings.Contains(baseRule, "|") {
			t.Fatalf("Redis 6.2 base ACL must not include Redis-7-only subcommand rule %s", baseRule)
		}
		hasScriptDeny = hasScriptDeny || baseRule == "-script"
	}
	if !hasScriptDeny {
		t.Fatalf("Redis 6.2 base ACL must deny SCRIPT because it cannot safely allow only selected subcommands: %v", baseRules)
	}
	if len(redisBindingACLModernRules()) != 10 {
		t.Fatalf("expected all Redis-7-only ACL rules to be gated, got %v", redisBindingACLModernRules())
	}
}

func TestRedisIdentityV2PersistsACLChangesAndDoesNotHideDeleteErrors(t *testing.T) {
	apply := redisBindingPrincipalV2ApplyCommand()
	drop := redisBindingPrincipalV2DropCommand()
	if !strings.Contains(apply, "ACL SAVE") || !strings.Contains(drop, "ACL SAVE") {
		t.Fatal("Redis identity-v2 apply and drop must persist ACL changes")
	}
	if strings.Contains(drop, "|| true") {
		t.Fatal("Redis identity-v2 drop must not suppress ACL deletion failures")
	}
	if !strings.Contains(drop, "0|1") {
		t.Fatal("Redis identity-v2 drop must accept only missing or one deleted user")
	}
	snapshot := redisACLFileSnapshotCommand()
	restore := redisACLFileRestoreCommand()
	if !strings.Contains(snapshot, `ACL LIST >"$tmp"`) || !strings.Contains(snapshot, "mv \"$tmp\" /data/users.acl") {
		t.Fatal("legacy Redis ACL migration must snapshot the live user set atomically")
	}
	if !strings.Contains(restore, "ACL SETUSER") || strings.Contains(restore, "|| true") {
		t.Fatal("legacy Redis ACL rollback must restore every snapshotted user without suppressing failures")
	}
}

func TestManagedRedisConfigUsesPersistentACLFile(t *testing.T) {
	config := managedRedisConfigText(managedDatabaseCommand{Type: "redis", MemoryBytes: 1024 * 1024})
	if !strings.Contains(config, "aclfile /data/users.acl\n") {
		t.Fatalf("managed Redis must load its ACL file from persistent storage: %q", config)
	}
}

func TestRedisIdentityV2Live(t *testing.T) {
	images := strings.TrimSpace(os.Getenv("GATEWAY_REDIS_IDENTITY_TEST_IMAGES"))
	if images == "" {
		t.Skip("set GATEWAY_REDIS_IDENTITY_TEST_IMAGES to run disposable Redis identity tests")
	}
	for _, image := range strings.Split(images, ",") {
		image = strings.TrimSpace(image)
		if image == "" {
			continue
		}
		t.Run(strings.ReplaceAll(image, ":", "-"), func(t *testing.T) {
			dataDir := t.TempDir()
			uid, gid, err := managedDatabaseTLSOwner("redis")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(dataDir, uid, gid); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(dataDir, 0750); err != nil {
				t.Fatal(err)
			}
			ownerPassword := "owner-password-123456"
			digest := sha256.Sum256([]byte(ownerPassword))
			aclPath := filepath.Join(dataDir, "users.acl")
			if err := os.WriteFile(
				aclPath,
				[]byte(fmt.Sprintf("user default on #%x ~* &* +@all\n", digest)),
				0600,
			); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(aclPath, uid, gid); err != nil {
				t.Fatal(err)
			}
			name := fmt.Sprintf("gateway-redis-identity-%d", time.Now().UnixNano())
			runDockerTestCommand(t, "run", "-d", "--rm", "--name", name,
				"-v", dataDir+":/data",
				image,
				"redis-server", "--dir", "/data", "--aclfile", "/data/users.acl",
			)
			t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
			deadline := time.Now().Add(30 * time.Second)
			for {
				if exec.Command("docker", "exec", "-e", "REDISCLI_AUTH="+ownerPassword, name,
					"redis-cli", "--no-auth-warning", "--user", "default", "PING").Run() == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("Redis did not become ready")
				}
				time.Sleep(250 * time.Millisecond)
			}

			runDockerTestCommand(t, "exec",
				"-e", "REDISCLI_AUTH="+ownerPassword,
				"-e", "GATEWAY_DB_PRINCIPAL=gw_b_one",
				"-e", "GATEWAY_DB_PRINCIPAL_PASSWORD=binding-password-123456",
				name, "sh", "-ec", redisBindingPrincipalV2ApplyCommand(),
			)
			runDockerTestCommand(t, "exec", "-e", "REDISCLI_AUTH=binding-password-123456", name,
				"redis-cli", "--no-auth-warning", "--user", "gw_b_one", "PING")
			runDockerTestCommand(t, "restart", name)
			runDockerTestCommand(t, "exec", "-e", "REDISCLI_AUTH=binding-password-123456", name,
				"redis-cli", "--no-auth-warning", "--user", "gw_b_one", "PING")

			runDockerTestCommand(t, "exec",
				"-e", "REDISCLI_AUTH="+ownerPassword,
				"-e", "GATEWAY_DB_PRINCIPAL=gw_b_one",
				name, "sh", "-ec", redisBindingPrincipalV2DropCommand(),
			)
			runDockerTestCommand(t, "restart", name)
			deletedProbe, _ := exec.Command("docker", "exec", "-e", "REDISCLI_AUTH=binding-password-123456", name,
				"redis-cli", "--no-auth-warning", "--user", "gw_b_one", "PING").CombinedOutput()
			if strings.TrimSpace(string(deletedProbe)) == "PONG" {
				t.Fatal("deleted Redis binding principal survived restart")
			}

			runDockerTestCommand(t, "exec",
				"-e", "GATEWAY_DB_CURRENT_OWNER_PASSWORD="+ownerPassword,
				"-e", "GATEWAY_DB_PENDING_OWNER_PASSWORD=rotated-owner-password-123456",
				name, "sh", "-ec", redisOwnerRotateCommand(),
			)
			// A lost ACK must be safely retryable with the persisted old and pending
			// credentials even though the external password has already changed.
			runDockerTestCommand(t, "exec",
				"-e", "GATEWAY_DB_CURRENT_OWNER_PASSWORD="+ownerPassword,
				"-e", "GATEWAY_DB_PENDING_OWNER_PASSWORD=rotated-owner-password-123456",
				name, "sh", "-ec", redisOwnerRotateCommand(),
			)
			runDockerTestCommand(t, "restart", name)
			oldOwnerProbe, _ := exec.Command("docker", "exec", "-e", "REDISCLI_AUTH="+ownerPassword, name,
				"redis-cli", "--no-auth-warning", "--user", "default", "PING").CombinedOutput()
			if strings.TrimSpace(string(oldOwnerProbe)) == "PONG" {
				t.Fatal("old Redis owner password remained valid")
			}
			runDockerTestCommand(t, "exec", "-e", "REDISCLI_AUTH=rotated-owner-password-123456", name,
				"redis-cli", "--no-auth-warning", "--user", "default", "PING")
		})
	}
}

func TestClickHouseBindingPrincipalV2UsesStableRole(t *testing.T) {
	sql := clickHouseBindingPrincipalV2ApplySQL(managedDatabasePrincipalV2Command{
		OperationID:              "11111111-1111-4111-8111-111111111111",
		PrincipalName:            "gw_b_123",
		Password:                 "a-long-random-secret-password",
		DatabaseName:             "app_database",
		ApplicationPrincipalName: "gw_app_123",
		OwnerUsername:            "app_owner",
		OwnerPassword:            "another-long-owner-secret",
	})
	for _, expected := range []string{
		`CREATE ROLE IF NOT EXISTS "gw_app_123"`,
		`GRANT ALL ON "app_database".* TO "gw_app_123"`,
		`GRANT "gw_app_123" TO "gw_b_123"`,
		`SET DEFAULT ROLE "gw_app_123" TO "gw_b_123"`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("ClickHouse identity-v2 SQL must contain %q: %q", expected, sql)
		}
	}
}

func TestClickHouseIdentityV2Live(t *testing.T) {
	images := strings.TrimSpace(os.Getenv("GATEWAY_CLICKHOUSE_IDENTITY_TEST_IMAGES"))
	if images == "" {
		t.Skip("set GATEWAY_CLICKHOUSE_IDENTITY_TEST_IMAGES to run disposable ClickHouse identity tests")
	}
	for _, image := range strings.Split(images, ",") {
		image = strings.TrimSpace(image)
		if image == "" {
			continue
		}
		t.Run(strings.NewReplacer(":", "-", "/", "-").Replace(image), func(t *testing.T) {
			name := fmt.Sprintf("gateway-clickhouse-identity-%d", time.Now().UnixNano())
			ownerUsername := strings.TrimSpace(os.Getenv("GATEWAY_CLICKHOUSE_IDENTITY_TEST_OWNER"))
			if ownerUsername == "" {
				ownerUsername = "clickhouse_owner"
			}
			ownerPassword := "owner-password-123456"
			pendingPassword := "rotated-owner-password-123456"
			overridePath := filepath.Join(t.TempDir(), filepath.Base(clickHouseOwnerOverrideContainerPath))
			if err := writeClickHouseOwnerOverride(overridePath, clickHouseOwnerOverrideConfig(ownerUsername, ownerPassword)); err != nil {
				t.Fatal(err)
			}
			runDockerTestCommand(t, "run", "-d", "--rm", "--name", name,
				"-e", "CLICKHOUSE_DB=app",
				"-e", "CLICKHOUSE_USER="+ownerUsername,
				"-e", "CLICKHOUSE_PASSWORD="+ownerPassword,
				"-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
				"-v", overridePath+":"+clickHouseOwnerOverrideContainerPath+":ro",
				image,
			)
			t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
			waitClickHouseReady(t, name, ownerUsername, ownerPassword)

			binding := managedDatabasePrincipalV2Command{
				OperationID:              "22222222-2222-4222-8222-222222222222",
				PrincipalName:            "gw_b_one",
				Password:                 "binding-password-123456",
				DatabaseName:             "app",
				ApplicationPrincipalName: "gw_app_123",
				OwnerUsername:            ownerUsername,
				OwnerPassword:            ownerPassword,
			}
			runClickHouseTestSQL(t, name, ownerUsername, ownerPassword, clickHouseBindingPrincipalV2ApplySQL(binding))
			runClickHouseTestSQL(t, name, "gw_b_one", binding.Password, "CREATE TABLE app.binding_table (id UInt64) ENGINE = MergeTree ORDER BY id; INSERT INTO app.binding_table VALUES (1);")
			runDockerTestCommand(t, "restart", name)
			waitClickHouseReady(t, name, "gw_b_one", binding.Password)
			runDockerTestCommand(t, "exec", "-e", "CLICKHOUSE_PASSWORD="+binding.Password, name,
				"clickhouse-client", "--user", binding.PrincipalName, "--database", "app", "--query", "SELECT count() FROM binding_table")

			for range 2 {
				if err := writeClickHouseOwnerOverride(overridePath, clickHouseOwnerOverrideConfig(ownerUsername, pendingPassword)); err != nil {
					t.Fatal(err)
				}
				runDockerTestCommand(t, "restart", name)
				waitClickHouseReady(t, name, ownerUsername, pendingPassword)
			}
			if exec.Command("docker", "exec", "-e", "CLICKHOUSE_PASSWORD="+ownerPassword, name,
				"clickhouse-client", "--user", ownerUsername, "--database", "app", "--query", "SELECT 1").Run() == nil {
				t.Fatal("old ClickHouse owner password remained valid")
			}
			runDockerTestCommand(t, "exec", "-e", "CLICKHOUSE_PASSWORD="+pendingPassword, name,
				"clickhouse-client", "--user", ownerUsername, "--database", "app", "--query", "SELECT 1")
			runClickHouseTestSQL(t, name, ownerUsername, pendingPassword, "DROP USER IF EXISTS \"gw_b_one\";")
		})
	}
}

func runClickHouseTestSQL(t *testing.T, containerName, username, password, sql string) {
	t.Helper()
	command := exec.Command("docker", "exec", "-i", "-e", "CLICKHOUSE_PASSWORD="+password, containerName,
		"clickhouse-client", "--user", username, "--database", "app", "--multiquery")
	command.Stdin = strings.NewReader(sql)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("execute ClickHouse SQL as %s: %v: %s", username, err, strings.TrimSpace(string(output)))
	}
}

func waitClickHouseReady(t *testing.T, containerName, username, password string) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		if exec.Command("docker", "exec", "-e", "CLICKHOUSE_PASSWORD="+password, containerName,
			"clickhouse-client", "--user", username, "--database", "app", "--query", "SELECT 1").Run() == nil {
			return
		}
		if time.Now().After(deadline) {
			logs, _ := exec.Command("docker", "logs", "--tail", "80", containerName).CombinedOutput()
			errLog, _ := exec.Command("docker", "exec", containerName, "sh", "-ec", "tail -80 /var/log/clickhouse-server/clickhouse-server.err.log; cat "+clickHouseOwnerOverrideContainerPath).CombinedOutput()
			t.Fatalf("ClickHouse did not become ready: %s\n%s", strings.TrimSpace(string(logs)), strings.TrimSpace(string(errLog)))
		}
		time.Sleep(500 * time.Millisecond)
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
