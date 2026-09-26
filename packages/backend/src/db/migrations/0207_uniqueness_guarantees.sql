-- Uniqueness guarantees move into the database: node host ports, proxy host domains, active backup runs, managed
-- storage names and certificate references. Existing collisions never fail this migration: host ports and proxy
-- domains are recorded with a conflict flag outside the unique index, older duplicate active runs are failed, and
-- later same-name storage clusters are renamed. Each case is written to the audit log.

-- 1. Node host port reservations ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "node_host_port_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"protocol" varchar(8) DEFAULT 'tcp' NOT NULL,
	"host_port" integer NOT NULL,
	"owner_kind" varchar(32) NOT NULL,
	"owner_id" uuid NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_host_port_reservations_protocol_valid" CHECK ("node_host_port_reservations"."protocol" IN ('tcp', 'udp')),
	CONSTRAINT "node_host_port_reservations_port_valid" CHECK ("node_host_port_reservations"."host_port" BETWEEN 1 AND 65535),
	CONSTRAINT "node_host_port_reservations_owner_kind_valid" CHECK ("node_host_port_reservations"."owner_kind" IN ('deployment', 'managed_storage', 'managed_database'))
);
--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" DROP CONSTRAINT IF EXISTS "node_host_port_reservations_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" ADD CONSTRAINT "node_host_port_reservations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_host_port_reservations_port_unique" ON "node_host_port_reservations" USING btree ("node_id","protocol","host_port") WHERE "node_host_port_reservations"."conflict" = false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_host_port_reservations_owner_port_unique" ON "node_host_port_reservations" USING btree ("owner_kind","owner_id","protocol","host_port");
--> statement-breakpoint
-- The host ports a managed storage cluster binds; mirrors `collectClusterHostPorts` in the private core.
CREATE OR REPLACE FUNCTION "managed_storage_cluster_host_ports"(
	"p_publish_s3" boolean,
	"p_published_port" integer,
	"p_sftp_enabled" boolean,
	"p_sftp_port" integer,
	"p_ftp_enabled" boolean,
	"p_ftp_port" integer,
	"p_ftp_passive_port_start" integer,
	"p_ftp_passive_port_count" integer
) RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$
	SELECT coalesce(array_agg("ports"."port"), '{}'::integer[])
	FROM (
		SELECT "p_published_port" AS "port" WHERE "p_publish_s3" IS DISTINCT FROM false
		UNION ALL SELECT "p_sftp_port" WHERE "p_sftp_enabled" AND "p_sftp_port" IS NOT NULL
		UNION ALL SELECT "p_ftp_port" WHERE "p_ftp_enabled" AND "p_ftp_port" IS NOT NULL
		UNION ALL SELECT generate_series("p_ftp_passive_port_start", "p_ftp_passive_port_start" + coalesce("p_ftp_passive_port_count", 10) - 1)
			WHERE "p_ftp_enabled" AND "p_ftp_passive_port_start" IS NOT NULL
	) AS "ports"
	WHERE "ports"."port" IS NOT NULL
$$;
--> statement-breakpoint
-- Makes an owner hold exactly `p_ports` on `p_node_id` (none when the node is null): releases the rest, reserves the
-- missing ones in port order. A port another owner holds, including a conflicting legacy row, is refused with a
-- unique violation on node_host_port_reservations_port_unique; the unique index settles two concurrent reservations.
-- In record mode (a port a daemon already bound, a migrated workload, or `SET LOCAL gateway.host_port_conflicts =
-- 'record'`) such a port is recorded with conflict = true instead. Ports outside 1-65535 (0 = let the daemon pick)
-- are not reservations.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_reserve"(
	"p_owner_kind" text,
	"p_owner_id" uuid,
	"p_node_id" uuid,
	"p_ports" integer[],
	"p_record_conflicts" boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	"v_ports" integer[];
	"v_port" integer;
	"v_record" boolean := "p_record_conflicts" OR coalesce(current_setting('gateway.host_port_conflicts', true), '') = 'record';
BEGIN
	"v_ports" := ARRAY(
		SELECT DISTINCT "requested"."port"
		FROM unnest(coalesce("p_ports", '{}'::integer[])) AS "requested"("port")
		WHERE "requested"."port" BETWEEN 1 AND 65535
		ORDER BY "requested"."port"
	);
	DELETE FROM "node_host_port_reservations" AS "held"
	WHERE "held"."owner_kind" = "p_owner_kind"
		AND "held"."owner_id" = "p_owner_id"
		AND "held"."protocol" = 'tcp'
		AND ("p_node_id" IS NULL OR "held"."node_id" <> "p_node_id" OR NOT ("held"."host_port" = ANY ("v_ports")));
	IF "p_node_id" IS NULL THEN
		RETURN;
	END IF;
	FOREACH "v_port" IN ARRAY "v_ports" LOOP
		CONTINUE WHEN EXISTS (
			SELECT 1 FROM "node_host_port_reservations" AS "own"
			WHERE "own"."owner_kind" = "p_owner_kind"
				AND "own"."owner_id" = "p_owner_id"
				AND "own"."protocol" = 'tcp'
				AND "own"."host_port" = "v_port"
		);
		IF EXISTS (
			SELECT 1 FROM "node_host_port_reservations" AS "other"
			WHERE "other"."node_id" = "p_node_id" AND "other"."protocol" = 'tcp' AND "other"."host_port" = "v_port"
		) THEN
			IF NOT "v_record" THEN
				RAISE EXCEPTION 'duplicate key value violates unique constraint "node_host_port_reservations_port_unique"'
					USING ERRCODE = 'unique_violation',
						CONSTRAINT = 'node_host_port_reservations_port_unique',
						TABLE = 'node_host_port_reservations',
						DETAIL = format('Key (node_id, protocol, host_port)=(%s, tcp, %s) already exists.', "p_node_id", "v_port");
			END IF;
			INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "conflict")
			VALUES ("p_node_id", 'tcp', "v_port", "p_owner_kind", "p_owner_id", true);
		ELSIF "v_record" THEN
			BEGIN
				INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id")
				VALUES ("p_node_id", 'tcp', "v_port", "p_owner_kind", "p_owner_id");
			EXCEPTION WHEN unique_violation THEN
				INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "conflict")
				VALUES ("p_node_id", 'tcp', "v_port", "p_owner_kind", "p_owner_id", true);
			END;
		ELSE
			INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id")
			VALUES ("p_node_id", 'tcp', "v_port", "p_owner_kind", "p_owner_id");
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint
-- A blue/green deployment holds its routes' host ports. `p_extra_ports` reserves ports a route change is about to
-- bind before the router moves; syncing again without them releases whatever the routes no longer name.
CREATE OR REPLACE FUNCTION "docker_deployment_host_ports_sync"(
	"p_deployment_id" uuid,
	"p_extra_ports" integer[] DEFAULT '{}'::integer[],
	"p_record_conflicts" boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "node_host_port_reservations_reserve"(
		'deployment',
		"p_deployment_id",
		(SELECT "deployment"."node_id" FROM "docker_deployments" AS "deployment" WHERE "deployment"."id" = "p_deployment_id"),
		ARRAY(
			SELECT "route"."host_port" FROM "docker_deployment_routes" AS "route"
			WHERE "route"."deployment_id" = "p_deployment_id"
		) || coalesce("p_extra_ports", '{}'::integer[]),
		"p_record_conflicts"
	);
END;
$$;
--> statement-breakpoint
-- Backfill every existing workload. When workloads already share a port, the earliest created keeps the reservation
-- and the later ones are recorded as conflicting (and still refused a new reservation of that port).
INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "conflict")
SELECT "owned"."node_id", 'tcp', "owned"."port", "owned"."owner_kind", "owned"."owner_id",
	row_number() OVER (
		PARTITION BY "owned"."node_id", "owned"."port"
		ORDER BY "owned"."created_at", "owned"."owner_kind", "owned"."owner_id"
	) > 1
FROM (
	SELECT DISTINCT "deployment"."node_id", "route"."host_port" AS "port", 'deployment' AS "owner_kind",
		"deployment"."id" AS "owner_id", "deployment"."created_at"
	FROM "docker_deployments" AS "deployment"
	JOIN "docker_deployment_routes" AS "route" ON "route"."deployment_id" = "deployment"."id"
	UNION
	SELECT "cluster"."node_id", "ports"."port", 'managed_storage', "cluster"."id", "cluster"."created_at"
	FROM "managed_storage_clusters" AS "cluster"
	CROSS JOIN LATERAL unnest("managed_storage_cluster_host_ports"(
		"cluster"."publish_s3", "cluster"."published_port", "cluster"."sftp_enabled", "cluster"."sftp_port",
		"cluster"."ftp_enabled", "cluster"."ftp_port", "cluster"."ftp_passive_port_start", "cluster"."ftp_passive_port_count"
	)) AS "ports"("port")
	UNION
	SELECT "instance"."node_id", "ports"."port", 'managed_database', "instance"."id", "instance"."created_at"
	FROM "managed_database_instances" AS "instance"
	CROSS JOIN LATERAL unnest(ARRAY["instance"."published_port", "instance"."published_native_port"]) AS "ports"("port")
) AS "owned"
WHERE "owned"."port" BETWEEN 1 AND 65535
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
SELECT 'node.host_port_conflict', 'node', "later"."node_id"::text,
	jsonb_build_object(
		'hostPort', "later"."host_port",
		'protocol', "later"."protocol",
		'ownerKind', "later"."owner_kind",
		'ownerId', "later"."owner_id",
		'heldByKind', "holder"."owner_kind",
		'heldById', "holder"."owner_id",
		'reason', 'Two Gateway-managed workloads already published this host port on the node when reservations were introduced. Move one of them to another port.'
	)
FROM "node_host_port_reservations" AS "later"
JOIN "node_host_port_reservations" AS "holder"
	ON "holder"."node_id" = "later"."node_id"
	AND "holder"."protocol" = "later"."protocol"
	AND "holder"."host_port" = "later"."host_port"
	AND "holder"."conflict" = false
WHERE "later"."conflict" = true;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "docker_deployment_routes_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM "docker_deployment_host_ports_sync"(NEW."deployment_id");
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM "docker_deployment_host_ports_sync"(OLD."deployment_id");
	ELSE
		PERFORM "docker_deployment_host_ports_sync"(OLD."deployment_id");
		IF NEW."deployment_id" IS DISTINCT FROM OLD."deployment_id" THEN
			PERFORM "docker_deployment_host_ports_sync"(NEW."deployment_id");
		END IF;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "docker_deployment_routes_host_ports" ON "docker_deployment_routes";
--> statement-breakpoint
CREATE TRIGGER "docker_deployment_routes_host_ports"
AFTER INSERT OR DELETE OR UPDATE OF "deployment_id", "host_port" ON "docker_deployment_routes"
FOR EACH ROW EXECUTE FUNCTION "docker_deployment_routes_host_ports_trigger"();
--> statement-breakpoint
-- A deployment moved to another node (a Docker migration cutover) already runs there: its ports are recorded on the
-- new node, flagged when another workload holds them, rather than failing the cutover.
CREATE OR REPLACE FUNCTION "docker_deployments_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "node_host_port_reservations_reserve"('deployment', OLD."id", NULL, NULL);
	ELSIF NEW."node_id" IS DISTINCT FROM OLD."node_id" THEN
		PERFORM "docker_deployment_host_ports_sync"(NEW."id", '{}'::integer[], true);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "docker_deployments_host_ports" ON "docker_deployments";
--> statement-breakpoint
CREATE TRIGGER "docker_deployments_host_ports"
AFTER DELETE OR UPDATE OF "node_id" ON "docker_deployments"
FOR EACH ROW EXECUTE FUNCTION "docker_deployments_host_ports_trigger"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "managed_storage_clusters_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "node_host_port_reservations_reserve"('managed_storage', OLD."id", NULL, NULL);
		RETURN NULL;
	END IF;
	PERFORM "node_host_port_reservations_reserve"(
		'managed_storage',
		NEW."id",
		NEW."node_id",
		"managed_storage_cluster_host_ports"(
			NEW."publish_s3", NEW."published_port", NEW."sftp_enabled", NEW."sftp_port",
			NEW."ftp_enabled", NEW."ftp_port", NEW."ftp_passive_port_start", NEW."ftp_passive_port_count"
		)
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "managed_storage_clusters_host_ports" ON "managed_storage_clusters";
--> statement-breakpoint
CREATE TRIGGER "managed_storage_clusters_host_ports"
AFTER INSERT OR DELETE OR UPDATE OF "node_id", "publish_s3", "published_port", "sftp_enabled", "sftp_port", "ftp_enabled", "ftp_port", "ftp_passive_port_start", "ftp_passive_port_count" ON "managed_storage_clusters"
FOR EACH ROW EXECUTE FUNCTION "managed_storage_clusters_host_ports_trigger"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "managed_database_instances_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "node_host_port_reservations_reserve"('managed_database', OLD."id", NULL, NULL);
		RETURN NULL;
	END IF;
	PERFORM "node_host_port_reservations_reserve"(
		'managed_database',
		NEW."id",
		NEW."node_id",
		ARRAY[NEW."published_port", NEW."published_native_port"]
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "managed_database_instances_host_ports" ON "managed_database_instances";
--> statement-breakpoint
CREATE TRIGGER "managed_database_instances_host_ports"
AFTER INSERT OR DELETE OR UPDATE OF "node_id", "published_port", "published_native_port" ON "managed_database_instances"
FOR EACH ROW EXECUTE FUNCTION "managed_database_instances_host_ports_trigger"();
--> statement-breakpoint

-- 2. Proxy host domains --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "proxy_host_domains" (
	"proxy_host_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean NOT NULL,
	"legacy_conflict" boolean DEFAULT false NOT NULL,
	CONSTRAINT "proxy_host_domains_pkey" PRIMARY KEY("proxy_host_id","domain")
);
--> statement-breakpoint
ALTER TABLE "proxy_host_domains" DROP CONSTRAINT IF EXISTS "proxy_host_domains_proxy_host_id_proxy_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "proxy_host_domains" ADD CONSTRAINT "proxy_host_domains_proxy_host_id_proxy_hosts_id_fk" FOREIGN KEY ("proxy_host_id") REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proxy_host_domains" DROP CONSTRAINT IF EXISTS "proxy_host_domains_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "proxy_host_domains" ADD CONSTRAINT "proxy_host_domains_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- The names a host serves, as nginx compares them: trimmed, lowercased, without duplicates.
CREATE OR REPLACE FUNCTION "proxy_host_normalized_domains"("p_domain_names" jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
	SELECT coalesce(array_agg(DISTINCT lower(btrim("served"."name")) ORDER BY lower(btrim("served"."name"))), '{}'::text[])
	FROM jsonb_array_elements_text(
		CASE WHEN jsonb_typeof("p_domain_names") = 'array' THEN "p_domain_names" ELSE '[]'::jsonb END
	) AS "served"("name")
	WHERE btrim("served"."name") <> ''
$$;
--> statement-breakpoint
-- Backfill. Among enabled hosts on one node that already serve the same name, the earliest created keeps it and the
-- later ones are flagged legacy_conflict (outside the unique index) until their domains, node or state change.
INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled", "legacy_conflict")
SELECT "host"."id", "host"."node_id", "served"."domain", "host"."enabled",
	"host"."enabled" AND row_number() OVER (
		PARTITION BY "host"."node_id", "served"."domain", "host"."enabled"
		ORDER BY "host"."created_at", "host"."id"
	) > 1
FROM "proxy_hosts" AS "host"
CROSS JOIN LATERAL unnest("proxy_host_normalized_domains"("host"."domain_names")) AS "served"("domain")
WHERE "host"."node_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
SELECT 'proxy_host.domain_conflict', 'proxy_host', "later"."proxy_host_id"::text,
	jsonb_build_object(
		'domain', "later"."domain",
		'nodeId', "later"."node_id",
		'servedByProxyHostId', "holder"."proxy_host_id",
		'reason', 'Two enabled proxy hosts on this node already served this name when domain uniqueness was introduced; nginx serves only one of them. Remove the name from one host or disable it.'
	)
FROM "proxy_host_domains" AS "later"
JOIN "proxy_host_domains" AS "holder"
	ON "holder"."node_id" = "later"."node_id"
	AND "holder"."domain" = "later"."domain"
	AND "holder"."enabled" = true
	AND "holder"."legacy_conflict" = false
WHERE "later"."legacy_conflict" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proxy_host_domains_node_domain_unique" ON "proxy_host_domains" USING btree ("node_id","domain") WHERE "proxy_host_domains"."enabled" = true AND "proxy_host_domains"."legacy_conflict" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proxy_host_domains_node_domain_idx" ON "proxy_host_domains" USING btree ("node_id","domain");
--> statement-breakpoint
-- Rebuilt (and so checked against the unique index) whenever a host's names, node or enabled state change; deletes
-- cascade. Any other write keeps the host's rows, legacy flags included.
CREATE OR REPLACE FUNCTION "proxy_hosts_domains_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."node_id" IS NOT DISTINCT FROM OLD."node_id"
			AND NEW."enabled" IS NOT DISTINCT FROM OLD."enabled"
			AND "proxy_host_normalized_domains"(NEW."domain_names") = "proxy_host_normalized_domains"(OLD."domain_names") THEN
			RETURN NULL;
		END IF;
	END IF;
	DELETE FROM "proxy_host_domains" WHERE "proxy_host_id" = NEW."id";
	IF NEW."node_id" IS NOT NULL THEN
		INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
		SELECT NEW."id", NEW."node_id", "served"."domain", NEW."enabled"
		FROM unnest("proxy_host_normalized_domains"(NEW."domain_names")) AS "served"("domain");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "proxy_hosts_domains_sync" ON "proxy_hosts";
--> statement-breakpoint
CREATE TRIGGER "proxy_hosts_domains_sync"
AFTER INSERT OR UPDATE OF "domain_names", "enabled", "node_id" ON "proxy_hosts"
FOR EACH ROW EXECUTE FUNCTION "proxy_hosts_domains_trigger"();
--> statement-breakpoint

-- 3. Certificate references: a certificate a proxy host serves cannot be deleted ---------------------------------
ALTER TABLE "proxy_hosts" DROP CONSTRAINT IF EXISTS "proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk";
--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD CONSTRAINT "proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk" FOREIGN KEY ("ssl_certificate_id") REFERENCES "public"."ssl_certificates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- 4. Active backup runs ---------------------------------------------------------------------------------------------
-- One queued or running backup per policy: a running run stays over a queued one, then the newest; the others fail
-- with a clear message and release their executor lease. The backup service asks the executor to cancel each
-- superseded runner before it cleans up the run's runtime.
WITH "ranked" AS (
	-- A running backup is kept over a queued one: its runner is working and its lease is taken.
	SELECT "run"."id", row_number() OVER (
		PARTITION BY "run"."policy_id"
		ORDER BY ("run"."status" = 'running') DESC, "run"."created_at" DESC, "run"."id" DESC
	) AS "rank"
	FROM "backup_runs" AS "run"
	WHERE "run"."direction" = 'backup' AND "run"."status" IN ('queued', 'running') AND "run"."policy_id" IS NOT NULL
), "superseded" AS (
	UPDATE "backup_runs"
	SET "status" = 'failed',
		"phase" = 'superseded',
		"sanitized_error" = 'Stopped during the Gateway upgrade: a newer backup of this policy was already queued or running, and a policy runs one backup at a time.',
		"runtime_cleanup_pending" = true,
		"encrypted_runtime_payload" = NULL,
		"completed_at" = now(),
		"updated_at" = now()
	FROM "ranked"
	WHERE "backup_runs"."id" = "ranked"."id" AND "ranked"."rank" > 1
	RETURNING "backup_runs"."id", "backup_runs"."policy_id", "backup_runs"."database_connection_id"
), "released" AS (
	DELETE FROM "backup_run_node_leases" USING "superseded"
	WHERE "backup_run_node_leases"."run_id" = "superseded"."id"
)
INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
SELECT 'database.backup.superseded', 'database', "superseded"."database_connection_id"::text,
	jsonb_build_object('runId', "superseded"."id", 'policyId', "superseded"."policy_id", 'direction', 'backup')
FROM "superseded";
--> statement-breakpoint
-- One queued or running restore into a new managed database name, resolved the same way.
WITH "ranked" AS (
	SELECT "run"."id", row_number() OVER (
		PARTITION BY ("run"."restore_target" ->> 'newManagedDatabaseName')
		ORDER BY ("run"."status" = 'running') DESC, "run"."created_at" DESC, "run"."id" DESC
	) AS "rank"
	FROM "backup_runs" AS "run"
	WHERE "run"."direction" = 'restore'
		AND "run"."status" IN ('queued', 'running')
		AND ("run"."restore_target" ->> 'newManagedDatabaseName') IS NOT NULL
), "superseded" AS (
	UPDATE "backup_runs"
	SET "status" = 'failed',
		"phase" = 'superseded',
		"sanitized_error" = 'Stopped during the Gateway upgrade: a newer restore into the same new database was already queued or running.',
		"runtime_cleanup_pending" = true,
		"encrypted_runtime_payload" = NULL,
		"completed_at" = now(),
		"updated_at" = now()
	FROM "ranked"
	WHERE "backup_runs"."id" = "ranked"."id" AND "ranked"."rank" > 1
	RETURNING "backup_runs"."id", "backup_runs"."database_connection_id", "backup_runs"."restore_target"
), "released" AS (
	DELETE FROM "backup_run_node_leases" USING "superseded"
	WHERE "backup_run_node_leases"."run_id" = "superseded"."id"
)
INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
SELECT 'database.backup.superseded', 'database', "superseded"."database_connection_id"::text,
	jsonb_build_object(
		'runId', "superseded"."id",
		'direction', 'restore',
		'newManagedDatabaseName', "superseded"."restore_target" ->> 'newManagedDatabaseName'
	)
FROM "superseded";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_policy_active_unique" ON "backup_runs" USING btree ("policy_id") WHERE "backup_runs"."direction" = 'backup' AND "backup_runs"."status" IN ('queued', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_restore_new_database_active_unique" ON "backup_runs" USING btree (("restore_target" ->> 'newManagedDatabaseName')) WHERE "backup_runs"."direction" = 'restore' AND "backup_runs"."status" IN ('queued', 'running') AND ("backup_runs"."restore_target" ->> 'newManagedDatabaseName') IS NOT NULL;
--> statement-breakpoint

-- 5. Managed storage names ------------------------------------------------------------------------------------------
-- A node keeps one cluster per name. The earliest created keeps it; later ones (and their canonical connection, whose
-- name mirrors the cluster's) get the first free "-2", "-3", ... suffix.
DO $$
DECLARE
	"v_duplicate" record;
	"v_candidate" text;
	"v_suffix" integer;
BEGIN
	FOR "v_duplicate" IN
		SELECT "ranked"."id", "ranked"."node_id", "ranked"."name", "ranked"."object_storage_connection_id"
		FROM (
			SELECT "cluster"."id", "cluster"."node_id", "cluster"."name", "cluster"."object_storage_connection_id",
				row_number() OVER (PARTITION BY "cluster"."node_id", "cluster"."name" ORDER BY "cluster"."created_at", "cluster"."id") AS "rank"
			FROM "managed_storage_clusters" AS "cluster"
			WHERE "cluster"."status" <> 'deleting'
		) AS "ranked"
		WHERE "ranked"."rank" > 1
		ORDER BY "ranked"."node_id", "ranked"."name", "ranked"."rank"
	LOOP
		"v_suffix" := 2;
		LOOP
			"v_candidate" := left("v_duplicate"."name", 255 - length('-' || "v_suffix")) || '-' || "v_suffix";
			EXIT WHEN NOT EXISTS (
				SELECT 1 FROM "managed_storage_clusters" AS "other"
				WHERE "other"."node_id" = "v_duplicate"."node_id"
					AND "other"."name" = "v_candidate"
					AND "other"."status" <> 'deleting'
			);
			"v_suffix" := "v_suffix" + 1;
		END LOOP;
		UPDATE "managed_storage_clusters" SET "name" = "v_candidate", "updated_at" = now() WHERE "id" = "v_duplicate"."id";
		UPDATE "object_storage_connections" SET "name" = "v_candidate", "updated_at" = now()
		WHERE "id" = "v_duplicate"."object_storage_connection_id" AND "name" = "v_duplicate"."name";
		INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
		VALUES (
			'storage.managed.renamed_duplicate',
			'managed_storage_cluster',
			"v_duplicate"."id"::text,
			jsonb_build_object(
				'previousName', "v_duplicate"."name",
				'name', "v_candidate",
				'nodeId', "v_duplicate"."node_id",
				'reason', 'Another managed storage cluster on this node already had this name when names became unique per node.'
			)
		);
		RAISE WARNING 'Managed storage cluster % renamed from "%" to "%": the name is already used on node %',
			"v_duplicate"."id", "v_duplicate"."name", "v_candidate", "v_duplicate"."node_id";
	END LOOP;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_storage_clusters_node_name_active_unique" ON "managed_storage_clusters" USING btree ("node_id","name") WHERE "managed_storage_clusters"."status" <> 'deleting';
