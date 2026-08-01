package docker

import (
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

func TestRedisBindingACLCannotAdministerTheServer(t *testing.T) {
	command := redisBindingACLCommand()
	for _, allowed := range []string{"'+@read'", "'+@write'", "'+@connection'", "'+@transaction'", "'+@pubsub'", "'+eval'", "'+evalsha'", "'+fcall'", "'+script|load'", "'-function'", "'-script|flush'", "'-@dangerous'"} {
		if !strings.Contains(command, allowed) {
			t.Fatalf("Redis binding ACL must include %s", allowed)
		}
	}
	if strings.Contains(command, "+@all") || strings.Contains(command, "+@admin") || strings.Contains(command, "+@scripting") {
		t.Fatal("Redis binding ACL must not grant all, administrative, or scripting command categories")
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
