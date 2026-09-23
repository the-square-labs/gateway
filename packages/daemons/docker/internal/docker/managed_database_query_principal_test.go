package docker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validPostgresQueryPrincipalInput() postgresQueryPrincipalCommand {
	return postgresQueryPrincipalCommand{
		Username:      "gw_query_reader",
		Password:      "a-long-random-reader-password",
		DatabaseName:  "app_database",
		OwnerUsername: "gateway_admin",
		OwnerPassword: "another-long-owner-secret",
	}
}

func TestValidatePostgresQueryPrincipalInputRejectsUnsafeValues(t *testing.T) {
	if err := validatePostgresQueryPrincipalInput(validPostgresQueryPrincipalInput()); err != nil {
		t.Fatalf("expected valid query principal input: %v", err)
	}
	for name, mutate := range map[string]func(*postgresQueryPrincipalCommand){
		"unsafe reader name":     func(input *postgresQueryPrincipalCommand) { input.Username = `reader"; DROP ROLE x; --` },
		"unsafe owner name":      func(input *postgresQueryPrincipalCommand) { input.OwnerUsername = "owner-name" },
		"unsafe database name":   func(input *postgresQueryPrincipalCommand) { input.DatabaseName = "app database" },
		"reader is the owner":    func(input *postgresQueryPrincipalCommand) { input.Username = input.OwnerUsername },
		"reserved role name":     func(input *postgresQueryPrincipalCommand) { input.Username = "pg_read_all_data" },
		"short reader password":  func(input *postgresQueryPrincipalCommand) { input.Password = "short" },
		"long reader password":   func(input *postgresQueryPrincipalCommand) { input.Password = strings.Repeat("p", 513) },
		"short owner password":   func(input *postgresQueryPrincipalCommand) { input.OwnerPassword = "short" },
		"missing reader":         func(input *postgresQueryPrincipalCommand) { input.Username = "" },
		"missing owner password": func(input *postgresQueryPrincipalCommand) { input.OwnerPassword = "" },
	} {
		t.Run(name, func(t *testing.T) {
			input := validPostgresQueryPrincipalInput()
			mutate(&input)
			if err := validatePostgresQueryPrincipalInput(input); err == nil {
				t.Fatal("expected unsafe query principal input to be rejected")
			}
		})
	}
}

func TestPostgresQueryPrincipalSQLCreatesReadOnlyNonSuperuser(t *testing.T) {
	sql := postgresQueryPrincipalApplySQL(validPostgresQueryPrincipalInput())
	if !strings.HasPrefix(sql, "RESET ROLE;\n") || !strings.HasSuffix(sql, "\n") {
		t.Fatalf("query principal SQL must reset the session role and end with a newline: %q", sql)
	}
	for _, expected := range []string{
		`CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L`,
		`ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L`,
		`ALTER ROLE %I SET default_transaction_read_only = on`,
		`GRANT CONNECT ON DATABASE %I TO %I`,
		`current_setting('server_version_num')::int >= 140000`,
		`GRANT pg_read_all_data TO %I`,
		`GRANT USAGE ON SCHEMA %I TO %I`,
		`GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I`,
		`GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I`,
		`nspname !~ '^pg_' AND nspname <> 'information_schema'`,
		`RAISE EXCEPTION 'query principal % is an existing superuser', reader;`,
		`reader text := 'gw_query_reader';`,
		`database_name text := 'app_database';`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("query principal SQL must contain %q: %s", expected, sql)
		}
	}
	for _, forbidden := range []string{" SUPERUSER ", "CREATEROLE PASSWORD", "GRANT ALL", "INSERT", "UPDATE", "DELETE"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("query principal SQL must not contain %q: %s", forbidden, sql)
		}
	}
	if strings.Contains(sql, "%%") {
		t.Fatalf("query principal SQL kept an unexpanded format escape: %s", sql)
	}
}

func TestPostgresQueryPrincipalSQLQuotesUntrustedValues(t *testing.T) {
	input := validPostgresQueryPrincipalInput()
	input.Password = `it's$gateway$; DROP ROLE gateway_admin; --`
	sql := postgresQueryPrincipalApplySQL(input)
	if !strings.Contains(sql, `reader_password text := 'it''s$gateway$; DROP ROLE gateway_admin; --';`) {
		t.Fatalf("password literal was not quoted: %s", sql)
	}
	body := strings.TrimPrefix(sql, "RESET ROLE;\nDO ")
	tag := body[:strings.Index(body[1:], "$")+2]
	if tag == "$gateway$" {
		t.Fatalf("dollar-quote tag must not be one the password contains: %s", sql)
	}
	if !strings.HasSuffix(sql, "END\n"+tag+";\n") || strings.Count(sql, tag) != 2 {
		t.Fatalf("password can close the DO block early with tag %q: %s", tag, sql)
	}
}

func TestPostgresQueryPrincipalPasswordsStayOutOfProcessArguments(t *testing.T) {
	input := validPostgresQueryPrincipalInput()
	apply := postgresQueryPrincipalApplyCommand(input)
	probe := postgresQueryPrincipalProbeCommand(input)
	for name, command := range map[string][]string{"apply": apply, "probe": probe} {
		joined := strings.Join(command, " ")
		if strings.Contains(joined, input.Password) || strings.Contains(joined, input.OwnerPassword) {
			t.Fatalf("%s command exposes a password in process arguments: %q", name, command)
		}
	}
	if strings.Join(apply, " ") != "psql -v ON_ERROR_STOP=1 -U gateway_admin -d app_database" {
		t.Fatalf("apply must run as the owner: %q", apply)
	}
	if strings.Join(probe[:9], " ") != "psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gw_query_reader -d app_database" || probe[9] != "-tAc" {
		t.Fatalf("probe must log in as the reader over TCP: %q", probe)
	}
}

func TestPostgresQueryPrincipalProbeFailsForWritableRoles(t *testing.T) {
	for _, attribute := range []string{"r.rolsuper", "r.rolcreaterole", "r.rolcreatedb", "r.rolreplication", "current_setting('transaction_read_only') <> 'on'"} {
		if !strings.Contains(postgresQueryPrincipalProbeSQL, attribute) {
			t.Fatalf("probe must fail on %s: %s", attribute, postgresQueryPrincipalProbeSQL)
		}
	}
	// A constant 1/0 in a CASE arm is folded at plan time and always fails.
	if strings.Contains(postgresQueryPrincipalProbeSQL, "1/0") || !strings.Contains(postgresQueryPrincipalProbeSQL, "1 / (CASE WHEN") {
		t.Fatalf("probe divisor must depend on row data: %s", postgresQueryPrincipalProbeSQL)
	}
}

func TestPostgresQueryPrincipalActionRejectsOtherEngines(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "records"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := &managedDatabaseManager{root: root}
	id := "database_1"
	if err := manager.saveRecord(managedDatabaseRecord{
		ID:        id,
		Type:      "redis",
		ImagePath: filepath.Join(root, "images", id+".img"),
		MountPath: filepath.Join(root, "mounts", id),
	}); err != nil {
		t.Fatal(err)
	}
	payload := `{"username":"gw_query_reader","password":"a-long-random-reader-password","databaseName":"app_database","ownerUsername":"gateway_admin","ownerPassword":"another-long-owner-secret"}`
	if _, err := manager.handle(context.Background(), "postgres_query_principal_apply_v1", id, payload); err == nil || err.Error() != "query principals are supported only for PostgreSQL" {
		t.Fatalf("expected non-PostgreSQL engine to be rejected, got %v", err)
	}
	unsafe := strings.Replace(payload, `"gw_query_reader"`, `"gateway_admin"`, 1)
	if _, err := manager.handle(context.Background(), "postgres_query_principal_apply_v1", id, unsafe); err == nil || !strings.Contains(err.Error(), "dedicated role") {
		t.Fatalf("expected owner reuse to be rejected before any engine command, got %v", err)
	}
}

func TestStorageProfileAdvertisesPostgresQueryPrincipal(t *testing.T) {
	joined := strings.Join(storagePluginForTest().BuildRegisterMessage("node-1").Capabilities, ",")
	if !strings.Contains(joined, "managed_postgres_query_principal_v1") {
		t.Fatalf("storage profile must advertise the PostgreSQL query principal: %s", joined)
	}
}

// postgresIdentityTestImages lists the disposable PostgreSQL images the live
// identity tests run against, skipping the test when none is configured.
func postgresIdentityTestImages(t *testing.T) []string {
	t.Helper()
	var images []string
	for _, image := range strings.Split(os.Getenv("GATEWAY_POSTGRES_IDENTITY_TEST_IMAGES"), ",") {
		if image = strings.TrimSpace(image); image != "" {
			images = append(images, image)
		}
	}
	if len(images) == 0 {
		t.Skip("set GATEWAY_POSTGRES_IDENTITY_TEST_IMAGES to run disposable PostgreSQL identity tests")
	}
	return images
}

// startPostgresQueryPrincipalTestContainer runs a disposable server whose
// superuser gateway_admin owns the "app" database, and waits until it is ready.
func startPostgresQueryPrincipalTestContainer(t *testing.T, image string) string {
	t.Helper()
	name := fmt.Sprintf("gateway-pg-query-principal-%d", time.Now().UnixNano())
	runDockerTestCommand(t, "run", "-d", "--rm", "--name", name,
		"-e", "POSTGRES_USER=gateway_admin",
		"-e", "POSTGRES_PASSWORD=admin-password-123456",
		"-e", "POSTGRES_DB=app",
		image,
	)
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	deadline := time.Now().Add(30 * time.Second)
	for {
		if exec.Command("docker", "exec", "-e", "PGPASSWORD=admin-password-123456", name,
			"pg_isready", "-q", "-h", "127.0.0.1", "-U", "gateway_admin", "-d", "app").Run() == nil {
			return name
		}
		if time.Now().After(deadline) {
			t.Fatal("PostgreSQL did not become ready")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func TestPostgresQueryPrincipalLive(t *testing.T) {
	for _, image := range postgresIdentityTestImages(t) {
		t.Run(strings.ReplaceAll(image, ":", "-"), func(t *testing.T) {
			name := startPostgresQueryPrincipalTestContainer(t, image)
			runPostgresTestSQL(t, name, "gateway_admin", "admin-password-123456", `CREATE SCHEMA app_extra;
CREATE TABLE app_extra.items(id integer);
INSERT INTO app_extra.items VALUES (1);
ALTER TABLE app_extra.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_extra.items FORCE ROW LEVEL SECURITY;`)

			input := postgresQueryPrincipalCommand{
				Username:      "gw_query_reader",
				Password:      "reader-password-123456",
				DatabaseName:  "app",
				OwnerUsername: "gateway_admin",
				OwnerPassword: "admin-password-123456",
			}
			// Applying twice proves retries converge on an existing role.
			for range 2 {
				runPostgresTestSQL(t, name, input.OwnerUsername, input.OwnerPassword, postgresQueryPrincipalApplySQL(input))
				runDockerTestCommand(t, append([]string{"exec", "-e", "PGPASSWORD=" + input.Password, name}, postgresQueryPrincipalProbeCommand(input)...)...)
			}
			if rows := runPostgresTestQuery(t, name, input.Username, input.Password, `SELECT count(*) FROM app_extra.items`); strings.TrimSpace(rows) != "1" {
				t.Fatalf("reader must see rows past row level security, got %q", rows)
			}
			for _, write := range []string{
				`INSERT INTO app_extra.items VALUES (2)`,
				`SET default_transaction_read_only = off; INSERT INTO app_extra.items VALUES (2)`,
				`SET default_transaction_read_only = off; DROP TABLE app_extra.items`,
			} {
				if output, err := exec.Command("docker", "exec", "-e", "PGPASSWORD="+input.Password, name,
					"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.Username, "-d", "app", "-c", write).CombinedOutput(); err == nil {
					t.Fatalf("reader write succeeded: %s: %s", write, output)
				}
			}
		})
	}
}

func validPostgresQueryWriterInput() postgresQueryWriterCommand {
	return postgresQueryWriterCommand{
		Username:                 "gw_pg_write_1",
		Password:                 "a-long-random-writer-password",
		DatabaseName:             "app_database",
		ApplicationPrincipalName: "gw_app_1",
		OwnerUsername:            "gateway_admin",
		OwnerPassword:            "another-long-owner-secret",
	}
}

func TestValidatePostgresQueryWriterInputRejectsUnsafeValues(t *testing.T) {
	if err := validatePostgresQueryWriterInput(validPostgresQueryWriterInput()); err != nil {
		t.Fatalf("expected valid query writer input: %v", err)
	}
	for name, mutate := range map[string]func(*postgresQueryWriterCommand){
		"unsafe writer name":            func(input *postgresQueryWriterCommand) { input.Username = `writer"; DROP ROLE x; --` },
		"unsafe application name":       func(input *postgresQueryWriterCommand) { input.ApplicationPrincipalName = "app role" },
		"unsafe owner name":             func(input *postgresQueryWriterCommand) { input.OwnerUsername = "owner-name" },
		"unsafe database name":          func(input *postgresQueryWriterCommand) { input.DatabaseName = "app database" },
		"writer is the owner":           func(input *postgresQueryWriterCommand) { input.Username = input.OwnerUsername },
		"writer is the application":     func(input *postgresQueryWriterCommand) { input.Username = input.ApplicationPrincipalName },
		"application is the superuser":  func(input *postgresQueryWriterCommand) { input.ApplicationPrincipalName = input.OwnerUsername },
		"reserved writer name":          func(input *postgresQueryWriterCommand) { input.Username = "pg_write_all_data" },
		"reserved application name":     func(input *postgresQueryWriterCommand) { input.ApplicationPrincipalName = "pg_execute_server_program" },
		"short writer password":         func(input *postgresQueryWriterCommand) { input.Password = "short" },
		"long writer password":          func(input *postgresQueryWriterCommand) { input.Password = strings.Repeat("p", 513) },
		"missing owner password":        func(input *postgresQueryWriterCommand) { input.OwnerPassword = "" },
		"missing application principal": func(input *postgresQueryWriterCommand) { input.ApplicationPrincipalName = "" },
	} {
		t.Run(name, func(t *testing.T) {
			input := validPostgresQueryWriterInput()
			mutate(&input)
			if err := validatePostgresQueryWriterInput(input); err == nil {
				t.Fatal("expected unsafe query writer input to be rejected")
			}
		})
	}
}

func TestPostgresQueryWriterSQLCreatesNonSuperuserApplicationMember(t *testing.T) {
	sql := postgresQueryWriterApplySQL(validPostgresQueryWriterInput())
	if !strings.HasPrefix(sql, "RESET ROLE;\nDO $gateway$\n") || !strings.HasSuffix(sql, "END\n$gateway$;\n") {
		t.Fatalf("query writer SQL must reset the session role and be one DO block: %q", sql)
	}
	for _, expected := range []string{
		`CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`,
		`ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`,
		`GRANT %I TO %I', application_owner, writer`,
		`GRANT CONNECT ON DATABASE %I TO %I`,
		`RAISE EXCEPTION 'application role % does not exist', application_owner;`,
		`RAISE EXCEPTION 'application role % can reach administrative privileges', application_owner;`,
		`RAISE EXCEPTION 'query writer % is an existing superuser', writer;`,
		`pg_has_role(application_owner::name, s.oid, 'MEMBER')`,
		postgresAdministrativeRoleSQL,
		`writer text := 'gw_pg_write_1';`,
		`application_owner text := 'gw_app_1';`,
		`database_name text := 'app_database';`,
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("query writer SQL must contain %q: %s", expected, sql)
		}
	}
	for _, forbidden := range []string{" SUPERUSER ", " BYPASSRLS ", "GRANT ALL", "pg_write_all_data", "SET role", "gateway_admin"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("query writer SQL must not contain %q: %s", forbidden, sql)
		}
	}
	if strings.Contains(sql, "%%") || strings.Contains(sql, "%!") {
		t.Fatalf("query writer SQL kept an unexpanded or broken format escape: %s", sql)
	}
	for _, attribute := range []string{"s.rolsuper", "s.rolcreaterole", "s.rolcreatedb", "s.rolreplication", "s.rolbypassrls", "pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"} {
		if !strings.Contains(postgresAdministrativeRoleSQL, attribute) {
			t.Fatalf("administrative role check must cover %s: %s", attribute, postgresAdministrativeRoleSQL)
		}
	}
}

func TestPostgresQueryWriterSQLQuotesUntrustedValues(t *testing.T) {
	input := validPostgresQueryWriterInput()
	input.Password = `it's$gateway$; DROP ROLE gateway_admin; --`
	sql := postgresQueryWriterApplySQL(input)
	if !strings.Contains(sql, `writer_password text := 'it''s$gateway$; DROP ROLE gateway_admin; --';`) {
		t.Fatalf("password literal was not quoted: %s", sql)
	}
	body := strings.TrimPrefix(sql, "RESET ROLE;\nDO ")
	tag := body[:strings.Index(body[1:], "$")+2]
	if tag == "$gateway$" || !strings.HasSuffix(sql, "END\n"+tag+";\n") || strings.Count(sql, tag) != 2 {
		t.Fatalf("password can close the DO block early with tag %q: %s", tag, sql)
	}
}

func TestPostgresQueryWriterPasswordsStayOutOfProcessArguments(t *testing.T) {
	input := validPostgresQueryWriterInput()
	apply := postgresQueryWriterApplyCommand(input)
	probe := postgresQueryWriterProbeCommand(input)
	for name, command := range map[string][]string{"apply": apply, "probe": probe} {
		joined := strings.Join(command, " ")
		if strings.Contains(joined, input.Password) || strings.Contains(joined, input.OwnerPassword) {
			t.Fatalf("%s command exposes a password in process arguments: %q", name, command)
		}
	}
	if strings.Join(apply, " ") != "psql -v ON_ERROR_STOP=1 -U gateway_admin -d app_database" {
		t.Fatalf("apply must run as the owner: %q", apply)
	}
	if strings.Join(probe[:9], " ") != "psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gw_pg_write_1 -d app_database" || probe[9] != "-tAc" {
		t.Fatalf("probe must log in as the writer over TCP: %q", probe)
	}
	probeSQL := probe[10]
	for _, expected := range []string{
		`pg_has_role(r.oid, 'gw_app_1'::name, 'USAGE')`,
		`pg_has_role(r.oid, s.oid, 'MEMBER')`,
		postgresAdministrativeRoleSQL,
		`r.rolname = session_user`,
		"1 / (CASE WHEN",
	} {
		if !strings.Contains(probeSQL, expected) {
			t.Fatalf("writer probe must contain %q: %s", expected, probeSQL)
		}
	}
}

func TestPostgresQueryWriterActionRejectsOtherEnginesAndUnsafeRoles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "records"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := &managedDatabaseManager{root: root}
	id := "database_1"
	if err := manager.saveRecord(managedDatabaseRecord{
		ID:        id,
		Type:      "clickhouse",
		ImagePath: filepath.Join(root, "images", id+".img"),
		MountPath: filepath.Join(root, "mounts", id),
	}); err != nil {
		t.Fatal(err)
	}
	payload := `{"username":"gw_pg_write_1","password":"a-long-random-writer-password","databaseName":"app_database","applicationPrincipalName":"gw_app_1","ownerUsername":"gateway_admin","ownerPassword":"another-long-owner-secret"}`
	if _, err := manager.handle(context.Background(), "postgres_query_writer_apply_v1", id, payload); err == nil || err.Error() != "query principals are supported only for PostgreSQL" {
		t.Fatalf("expected non-PostgreSQL engine to be rejected, got %v", err)
	}
	superuserApplication := strings.Replace(payload, `"gw_app_1"`, `"gateway_admin"`, 1)
	if _, err := manager.handle(context.Background(), "postgres_query_writer_apply_v1", id, superuserApplication); err == nil || !strings.Contains(err.Error(), "dedicated role") {
		t.Fatalf("expected joining the control owner to be rejected before any engine command, got %v", err)
	}
}

func TestStorageProfileAdvertisesPostgresQueryWriter(t *testing.T) {
	joined := strings.Join(storagePluginForTest().BuildRegisterMessage("node-1").Capabilities, ",")
	if !strings.Contains(joined, "managed_postgres_query_writer_v1") {
		t.Fatalf("storage profile must advertise the PostgreSQL query writer: %s", joined)
	}
}

func TestPostgresQueryWriterLive(t *testing.T) {
	for _, image := range postgresIdentityTestImages(t) {
		t.Run(strings.ReplaceAll(image, ":", "-"), func(t *testing.T) {
			name := startPostgresQueryPrincipalTestContainer(t, image)
			const admin, adminPassword = "gateway_admin", "admin-password-123456"
			// Mirrors owner separation: a NOLOGIN, non-administrative application
			// role owns the database objects; the superuser stays the control owner.
			runPostgresTestSQL(t, name, admin, adminPassword, `CREATE ROLE gw_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA app_extra AUTHORIZATION gw_app;
CREATE TABLE app_extra.items(id serial PRIMARY KEY, v integer);
ALTER TABLE app_extra.items OWNER TO gw_app;
INSERT INTO app_extra.items(v) VALUES (1);
CREATE TABLE public.control_only(id integer);`)

			input := postgresQueryWriterCommand{
				Username:                 "gw_pg_write",
				Password:                 "writer-password-123456",
				DatabaseName:             "app",
				ApplicationPrincipalName: "gw_app",
				OwnerUsername:            admin,
				OwnerPassword:            adminPassword,
			}
			probe := func() error {
				return exec.Command("docker", append([]string{"exec", "-e", "PGPASSWORD=" + input.Password, name}, postgresQueryWriterProbeCommand(input)...)...).Run()
			}
			// Applying twice proves retries converge on an existing role.
			for range 2 {
				runPostgresTestSQL(t, name, admin, adminPassword, postgresQueryWriterApplySQL(input))
				if err := probe(); err != nil {
					t.Fatalf("writer probe failed: %v", err)
				}
			}
			runPostgresTestSQL(t, name, input.Username, input.Password, `INSERT INTO app_extra.items(v) VALUES (2);
UPDATE app_extra.items SET v = v + 10 WHERE v = 1;
DELETE FROM app_extra.items WHERE v = 2;
SELECT nextval('app_extra.items_id_seq');`)
			if rows := runPostgresTestQuery(t, name, input.Username, input.Password, `SELECT string_agg(v::text, ',') FROM app_extra.items`); strings.TrimSpace(rows) != "11" {
				t.Fatalf("writer must read and write application tables, got %q", rows)
			}
			for _, denied := range []string{
				`SELECT pg_read_file('/etc/hostname')`,
				`COPY (SELECT 1) TO PROGRAM 'true'`,
				`ALTER SYSTEM SET work_mem = '8MB'`,
				`CREATE ROLE gw_escalated SUPERUSER`,
				`SET ROLE gateway_admin`,
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'gateway_admin'`,
				`INSERT INTO public.control_only VALUES (1)`,
			} {
				output, err := exec.Command("docker", "exec", "-e", "PGPASSWORD="+input.Password, name,
					"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.Username, "-d", "app", "-tAc", denied).CombinedOutput()
				if err == nil && !strings.Contains(denied, "pg_terminate_backend") {
					t.Fatalf("writer ran an administrative statement: %s: %s", denied, output)
				}
				if err == nil && strings.TrimSpace(string(output)) != "" {
					t.Fatalf("writer signalled a superuser backend: %s", output)
				}
			}

			// An application role that can reach superuser must be refused, and
			// the probe must catch a writer that gained such membership later.
			runPostgresTestSQL(t, name, admin, adminPassword, `GRANT pg_execute_server_program TO gw_app;`)
			command := exec.Command("docker", "exec", "-i", "-e", "PGPASSWORD="+adminPassword, name,
				"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", admin, "-d", "app")
			command.Stdin = strings.NewReader(postgresQueryWriterApplySQL(input))
			if output, err := command.CombinedOutput(); err == nil || !strings.Contains(string(output), "can reach administrative privileges") {
				t.Fatalf("apply must refuse an administrative application role: %v: %s", err, output)
			}
			if err := probe(); err == nil {
				t.Fatal("probe must fail once the writer can reach an administrative role")
			}
		})
	}
}
