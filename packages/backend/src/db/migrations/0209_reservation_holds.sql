-- Follow-ups to 0207 (rc.11 data review). Host port reservations gain holds (`pending_until`): ports kept for a change
-- in flight, such as a route change before the router moves or a database's old port until the daemon confirms the
-- move. They also gain Availability replica owners (the route ports a deployment's replicas bind on other nodes), a
-- plain lookup index, and the SQL the periodic reconcile uses. Proxy host domain rows can be written in record mode
-- (rollbacks restore prior state instead of failing) and keep their legacy flag when only `enabled` changes. Managed
-- storage gets one function that gives a cluster the first free name suffix, as 0207 did for existing duplicates.

-- 1. Reservation table ---------------------------------------------------------------------------------------------
ALTER TABLE "node_host_port_reservations" ADD COLUMN IF NOT EXISTS "pending_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" DROP CONSTRAINT IF EXISTS "node_host_port_reservations_owner_kind_valid";
--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" ADD CONSTRAINT "node_host_port_reservations_owner_kind_valid" CHECK ("node_host_port_reservations"."owner_kind" IN ('deployment', 'deployment_replica', 'managed_storage', 'managed_database'));
--> statement-breakpoint
-- Every lookup by port, conflicting rows included (the unique index is partial).
CREATE INDEX IF NOT EXISTS "node_host_port_reservations_node_port_idx" ON "node_host_port_reservations" USING btree ("node_id","protocol","host_port");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_host_port_reservations_pending_idx" ON "node_host_port_reservations" USING btree ("pending_until") WHERE "node_host_port_reservations"."pending_until" IS NOT NULL;
--> statement-breakpoint

-- 2. Reservation functions -----------------------------------------------------------------------------------------
-- Adds one port for an owner that has no row for it yet. A port another owner holds, a conflicting legacy row
-- included, is refused with a unique violation on node_host_port_reservations_port_unique, or recorded with
-- conflict = true in record mode. The unique index settles two concurrent reservations.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_add"(
	"p_owner_kind" text,
	"p_owner_id" uuid,
	"p_node_id" uuid,
	"p_port" integer,
	"p_record" boolean,
	"p_pending_until" timestamp with time zone
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "node_host_port_reservations" AS "other"
		WHERE "other"."node_id" = "p_node_id" AND "other"."protocol" = 'tcp' AND "other"."host_port" = "p_port"
	) THEN
		IF NOT "p_record" THEN
			RAISE EXCEPTION 'duplicate key value violates unique constraint "node_host_port_reservations_port_unique"'
				USING ERRCODE = 'unique_violation',
					CONSTRAINT = 'node_host_port_reservations_port_unique',
					TABLE = 'node_host_port_reservations',
					DETAIL = format('Key (node_id, protocol, host_port)=(%s, tcp, %s) already exists.', "p_node_id", "p_port");
		END IF;
		INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "conflict", "pending_until")
		VALUES ("p_node_id", 'tcp', "p_port", "p_owner_kind", "p_owner_id", true, "p_pending_until");
	ELSIF "p_record" THEN
		BEGIN
			INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "pending_until")
			VALUES ("p_node_id", 'tcp', "p_port", "p_owner_kind", "p_owner_id", "p_pending_until");
		EXCEPTION WHEN unique_violation THEN
			INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "conflict", "pending_until")
			VALUES ("p_node_id", 'tcp', "p_port", "p_owner_kind", "p_owner_id", true, "p_pending_until");
		END;
	ELSE
		INSERT INTO "node_host_port_reservations" ("node_id", "protocol", "host_port", "owner_kind", "owner_id", "pending_until")
		VALUES ("p_node_id", 'tcp', "p_port", "p_owner_kind", "p_owner_id", "p_pending_until");
	END IF;
END;
$$;
--> statement-breakpoint
-- Makes an owner hold the ports it names, `p_ports`, on `p_node_id` (none when the node is null): releases the ports
-- it no longer names and reserves the missing ones in port order. A hold (pending_until set) is kept until it is
-- settled or the reconcile releases it, except on a node the owner has left. Record mode as in 0207: the argument, or
-- `SET LOCAL gateway.host_port_conflicts = 'record'`. Ports outside 1-65535 (0 = let the daemon pick) are not
-- reservations.
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
		AND (
			"p_node_id" IS NULL
			OR "held"."node_id" <> "p_node_id"
			OR ("held"."pending_until" IS NULL AND NOT ("held"."host_port" = ANY ("v_ports")))
		);
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
		PERFORM "node_host_port_reservations_add"("p_owner_kind", "p_owner_id", "p_node_id", "v_port", "v_record", NULL);
	END LOOP;
END;
$$;
--> statement-breakpoint
-- Keeps `p_ports` reserved for the owner until at least `p_until`, whether or not the owner names them: the new ports
-- of a change before the daemon applies it, or the old ports until the daemon confirms the move. A port the owner
-- already holds becomes a hold; a new one is reserved as in `node_host_port_reservations_reserve`.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_hold"(
	"p_owner_kind" text,
	"p_owner_id" uuid,
	"p_node_id" uuid,
	"p_ports" integer[],
	"p_until" timestamp with time zone,
	"p_record_conflicts" boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	"v_ports" integer[];
	"v_port" integer;
	"v_record" boolean := "p_record_conflicts" OR coalesce(current_setting('gateway.host_port_conflicts', true), '') = 'record';
BEGIN
	IF "p_node_id" IS NULL THEN
		RETURN;
	END IF;
	"v_ports" := ARRAY(
		SELECT DISTINCT "requested"."port"
		FROM unnest(coalesce("p_ports", '{}'::integer[])) AS "requested"("port")
		WHERE "requested"."port" BETWEEN 1 AND 65535
		ORDER BY "requested"."port"
	);
	UPDATE "node_host_port_reservations" AS "own"
	SET "pending_until" = GREATEST(coalesce("own"."pending_until", "p_until"), "p_until")
	WHERE "own"."owner_kind" = "p_owner_kind"
		AND "own"."owner_id" = "p_owner_id"
		AND "own"."protocol" = 'tcp'
		AND "own"."node_id" = "p_node_id"
		AND "own"."host_port" = ANY ("v_ports");
	FOREACH "v_port" IN ARRAY "v_ports" LOOP
		CONTINUE WHEN EXISTS (
			SELECT 1 FROM "node_host_port_reservations" AS "own"
			WHERE "own"."owner_kind" = "p_owner_kind"
				AND "own"."owner_id" = "p_owner_id"
				AND "own"."protocol" = 'tcp'
				AND "own"."host_port" = "v_port"
		);
		PERFORM "node_host_port_reservations_add"("p_owner_kind", "p_owner_id", "p_node_id", "v_port", "v_record", "p_until");
	END LOOP;
END;
$$;
--> statement-breakpoint
-- An Availability replica of a blue/green deployment binds the deployment's route ports on its placement node. The
-- deployment's own node is covered by the deployment's reservation. A replica already runs, or will run, where
-- Availability placed it, so its ports are recorded there (flagged when another workload holds one) rather than
-- failing the placement; once recorded they keep other workloads off them.
CREATE OR REPLACE FUNCTION "docker_availability_replica_host_ports_sync"("p_placement_id" uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	"v_node_id" uuid;
	"v_deployment_id" uuid;
	"v_home_node_id" uuid;
BEGIN
	SELECT "placement"."node_id", "policy"."deployment_id", "deployment"."node_id"
	INTO "v_node_id", "v_deployment_id", "v_home_node_id"
	FROM "docker_availability_placements" AS "placement"
	JOIN "docker_availability_policies" AS "policy"
		ON "policy"."id" = "placement"."policy_id" AND "policy"."resource_kind" = 'deployment'
	JOIN "docker_deployments" AS "deployment" ON "deployment"."id" = "policy"."deployment_id"
	WHERE "placement"."id" = "p_placement_id";
	IF NOT FOUND OR "v_node_id" = "v_home_node_id" THEN
		PERFORM "node_host_port_reservations_reserve"('deployment_replica', "p_placement_id", NULL, NULL);
		RETURN;
	END IF;
	PERFORM "node_host_port_reservations_reserve"(
		'deployment_replica',
		"p_placement_id",
		"v_node_id",
		ARRAY(
			SELECT "route"."host_port" FROM "docker_deployment_routes" AS "route"
			WHERE "route"."deployment_id" = "v_deployment_id"
		),
		true
	);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "docker_deployment_replicas_host_ports_sync"("p_deployment_id" uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	"v_placement_id" uuid;
BEGIN
	FOR "v_placement_id" IN
		SELECT "placement"."id"
		FROM "docker_availability_placements" AS "placement"
		JOIN "docker_availability_policies" AS "policy" ON "policy"."id" = "placement"."policy_id"
		WHERE "policy"."resource_kind" = 'deployment' AND "policy"."deployment_id" = "p_deployment_id"
		ORDER BY "placement"."id"
	LOOP
		PERFORM "docker_availability_replica_host_ports_sync"("v_placement_id");
	END LOOP;
END;
$$;
--> statement-breakpoint
-- Recomputes one owner's reservations from what the owner's rows name (none when the owner is gone). Holds stay.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_sync_owner"(
	"p_owner_kind" text,
	"p_owner_id" uuid,
	"p_record_conflicts" boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	"v_node_id" uuid;
	"v_ports" integer[];
BEGIN
	IF "p_owner_kind" = 'deployment' THEN
		PERFORM "docker_deployment_host_ports_sync"("p_owner_id", '{}'::integer[], "p_record_conflicts");
	ELSIF "p_owner_kind" = 'deployment_replica' THEN
		PERFORM "docker_availability_replica_host_ports_sync"("p_owner_id");
	ELSIF "p_owner_kind" = 'managed_storage' THEN
		SELECT "cluster"."node_id", "managed_storage_cluster_host_ports"(
			"cluster"."publish_s3", "cluster"."published_port", "cluster"."sftp_enabled", "cluster"."sftp_port",
			"cluster"."ftp_enabled", "cluster"."ftp_port", "cluster"."ftp_passive_port_start", "cluster"."ftp_passive_port_count"
		)
		INTO "v_node_id", "v_ports"
		FROM "managed_storage_clusters" AS "cluster" WHERE "cluster"."id" = "p_owner_id";
		PERFORM "node_host_port_reservations_reserve"('managed_storage', "p_owner_id", "v_node_id", "v_ports", "p_record_conflicts");
	ELSIF "p_owner_kind" = 'managed_database' THEN
		SELECT "instance"."node_id", ARRAY["instance"."published_port", "instance"."published_native_port"]
		INTO "v_node_id", "v_ports"
		FROM "managed_database_instances" AS "instance" WHERE "instance"."id" = "p_owner_id";
		PERFORM "node_host_port_reservations_reserve"('managed_database', "p_owner_id", "v_node_id", "v_ports", "p_record_conflicts");
	END IF;
END;
$$;
--> statement-breakpoint
-- Ends the owner's holds (`p_ports`, or all of them) and records what the owner names now. A change that settled
-- already happened, so named ports are recorded (flagged when another workload holds one), never refused.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_settle"(
	"p_owner_kind" text,
	"p_owner_id" uuid,
	"p_ports" integer[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "node_host_port_reservations" AS "own"
	SET "pending_until" = NULL
	WHERE "own"."owner_kind" = "p_owner_kind"
		AND "own"."owner_id" = "p_owner_id"
		AND "own"."pending_until" IS NOT NULL
		AND ("p_ports" IS NULL OR "own"."host_port" = ANY ("p_ports"));
	PERFORM "node_host_port_reservations_sync_owner"("p_owner_kind", "p_owner_id", true);
END;
$$;
--> statement-breakpoint
-- The database side of the periodic reconcile (holds past `pending_until` are left to the services, which know
-- whether a change is still in flight or a binding explains them):
--   1. release reservations whose owner is gone;
--   2. record every owner's named ports, flagged when another workload holds one;
--   3. give a port whose only reservations are conflicting ones to the earliest of them.
-- Returns how many orphaned reservations it released.
CREATE OR REPLACE FUNCTION "node_host_port_reservations_reconcile"() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
	"v_released" integer;
	"v_owner" record;
BEGIN
	DELETE FROM "node_host_port_reservations" AS "row"
	WHERE ("row"."owner_kind" = 'deployment' AND NOT EXISTS (SELECT 1 FROM "docker_deployments" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'deployment_replica' AND NOT EXISTS (SELECT 1 FROM "docker_availability_placements" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'managed_storage' AND NOT EXISTS (SELECT 1 FROM "managed_storage_clusters" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'managed_database' AND NOT EXISTS (SELECT 1 FROM "managed_database_instances" AS "o" WHERE "o"."id" = "row"."owner_id"));
	GET DIAGNOSTICS "v_released" = ROW_COUNT;
	FOR "v_owner" IN
		SELECT 'deployment' AS "kind", "id" FROM "docker_deployments"
		UNION ALL SELECT 'managed_storage', "id" FROM "managed_storage_clusters"
		UNION ALL SELECT 'managed_database', "id" FROM "managed_database_instances"
		UNION ALL SELECT 'deployment_replica', "placement"."id"
			FROM "docker_availability_placements" AS "placement"
			JOIN "docker_availability_policies" AS "policy" ON "policy"."id" = "placement"."policy_id"
			WHERE "policy"."resource_kind" = 'deployment'
	LOOP
		PERFORM "node_host_port_reservations_sync_owner"("v_owner"."kind", "v_owner"."id", true);
	END LOOP;
	BEGIN
		UPDATE "node_host_port_reservations" SET "conflict" = false
		WHERE "id" IN (
			SELECT DISTINCT ON ("waiting"."node_id", "waiting"."protocol", "waiting"."host_port") "waiting"."id"
			FROM "node_host_port_reservations" AS "waiting"
			WHERE "waiting"."conflict"
				AND NOT EXISTS (
					SELECT 1 FROM "node_host_port_reservations" AS "holder"
					WHERE "holder"."node_id" = "waiting"."node_id"
						AND "holder"."protocol" = "waiting"."protocol"
						AND "holder"."host_port" = "waiting"."host_port"
						AND NOT "holder"."conflict"
				)
			ORDER BY "waiting"."node_id", "waiting"."protocol", "waiting"."host_port", "waiting"."created_at", "waiting"."id"
		);
	EXCEPTION WHEN unique_violation THEN
		-- A reservation committed meanwhile holds the port: the next pass decides.
		NULL;
	END;
	RETURN "v_released";
END;
$$;
--> statement-breakpoint

-- 3. Owner triggers: replicas follow placements, route changes and deployment moves --------------------------------
CREATE OR REPLACE FUNCTION "docker_deployment_routes_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM "docker_deployment_host_ports_sync"(NEW."deployment_id");
		PERFORM "docker_deployment_replicas_host_ports_sync"(NEW."deployment_id");
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM "docker_deployment_host_ports_sync"(OLD."deployment_id");
		PERFORM "docker_deployment_replicas_host_ports_sync"(OLD."deployment_id");
	ELSE
		PERFORM "docker_deployment_host_ports_sync"(OLD."deployment_id");
		PERFORM "docker_deployment_replicas_host_ports_sync"(OLD."deployment_id");
		IF NEW."deployment_id" IS DISTINCT FROM OLD."deployment_id" THEN
			PERFORM "docker_deployment_host_ports_sync"(NEW."deployment_id");
			PERFORM "docker_deployment_replicas_host_ports_sync"(NEW."deployment_id");
		END IF;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "docker_deployments_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "node_host_port_reservations_reserve"('deployment', OLD."id", NULL, NULL);
	ELSIF NEW."node_id" IS DISTINCT FROM OLD."node_id" THEN
		-- A replica on the deployment's new node is now the deployment itself: release it first, so the deployment
		-- does not find its own ports held there.
		PERFORM "docker_deployment_replicas_host_ports_sync"(NEW."id");
		PERFORM "docker_deployment_host_ports_sync"(NEW."id", '{}'::integer[], true);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "docker_availability_placements_host_ports_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "node_host_port_reservations_reserve"('deployment_replica', OLD."id", NULL, NULL);
	ELSE
		PERFORM "docker_availability_replica_host_ports_sync"(NEW."id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "docker_availability_placements_host_ports" ON "docker_availability_placements";
--> statement-breakpoint
CREATE TRIGGER "docker_availability_placements_host_ports"
AFTER INSERT OR DELETE OR UPDATE OF "node_id", "policy_id" ON "docker_availability_placements"
FOR EACH ROW EXECUTE FUNCTION "docker_availability_placements_host_ports_trigger"();
--> statement-breakpoint
-- Backfill the replicas that exist already; ports another workload holds are recorded as conflicting.
DO $$
DECLARE
	"v_placement_id" uuid;
BEGIN
	FOR "v_placement_id" IN
		SELECT "placement"."id"
		FROM "docker_availability_placements" AS "placement"
		JOIN "docker_availability_policies" AS "policy" ON "policy"."id" = "placement"."policy_id"
		WHERE "policy"."resource_kind" = 'deployment'
		ORDER BY "placement"."created_at", "placement"."id"
	LOOP
		PERFORM "docker_availability_replica_host_ports_sync"("v_placement_id");
	END LOOP;
END;
$$;
--> statement-breakpoint
INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
SELECT 'node.host_port_conflict', 'node', "replica"."node_id"::text,
	jsonb_build_object(
		'hostPort', "replica"."host_port",
		'protocol', "replica"."protocol",
		'ownerKind', "replica"."owner_kind",
		'ownerId', "replica"."owner_id",
		'heldByKind', "holder"."owner_kind",
		'heldById', "holder"."owner_id",
		'reason', 'An Availability replica binds this host port on a node where another Gateway-managed workload already reserved it. Move one of them to another port.'
	)
FROM "node_host_port_reservations" AS "replica"
JOIN "node_host_port_reservations" AS "holder"
	ON "holder"."node_id" = "replica"."node_id"
	AND "holder"."protocol" = "replica"."protocol"
	AND "holder"."host_port" = "replica"."host_port"
	AND "holder"."conflict" = false
WHERE "replica"."owner_kind" = 'deployment_replica' AND "replica"."conflict" = true;
--> statement-breakpoint

-- 4. Proxy host domains --------------------------------------------------------------------------------------------
-- Rows are rebuilt (and so checked against the unique index) when a host's names or node change. When only `enabled`
-- changes, each row keeps its legacy flag. In record mode (`SET LOCAL gateway.proxy_domain_conflicts = 'record'`,
-- used when a failed nginx apply restores a host's prior state), a name another enabled host serves is kept as a
-- legacy conflict instead of refused, so the rollback cannot fail and leave the database and nginx out of step.
CREATE OR REPLACE FUNCTION "proxy_hosts_domains_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	"v_record" boolean := coalesce(current_setting('gateway.proxy_domain_conflicts', true), '') = 'record';
	"v_domain" text;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."node_id" IS NOT DISTINCT FROM OLD."node_id"
			AND "proxy_host_normalized_domains"(NEW."domain_names") = "proxy_host_normalized_domains"(OLD."domain_names") THEN
			IF NEW."enabled" IS NOT DISTINCT FROM OLD."enabled" OR NEW."node_id" IS NULL THEN
				RETURN NULL;
			END IF;
			IF NOT NEW."enabled" OR NOT "v_record" THEN
				UPDATE "proxy_host_domains" SET "enabled" = NEW."enabled" WHERE "proxy_host_id" = NEW."id";
				RETURN NULL;
			END IF;
			FOR "v_domain" IN
				SELECT "row"."domain" FROM "proxy_host_domains" AS "row" WHERE "row"."proxy_host_id" = NEW."id" ORDER BY 1
			LOOP
				BEGIN
					UPDATE "proxy_host_domains" SET "enabled" = true
					WHERE "proxy_host_id" = NEW."id" AND "domain" = "v_domain";
				EXCEPTION WHEN unique_violation THEN
					UPDATE "proxy_host_domains" SET "enabled" = true, "legacy_conflict" = true
					WHERE "proxy_host_id" = NEW."id" AND "domain" = "v_domain";
				END;
			END LOOP;
			RETURN NULL;
		END IF;
	END IF;
	DELETE FROM "proxy_host_domains" WHERE "proxy_host_id" = NEW."id";
	IF NEW."node_id" IS NULL THEN
		RETURN NULL;
	END IF;
	FOREACH "v_domain" IN ARRAY "proxy_host_normalized_domains"(NEW."domain_names") LOOP
		IF "v_record" AND NEW."enabled" THEN
			BEGIN
				INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
				VALUES (NEW."id", NEW."node_id", "v_domain", true);
			EXCEPTION WHEN unique_violation THEN
				INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled", "legacy_conflict")
				VALUES (NEW."id", NEW."node_id", "v_domain", true, true);
			END;
		ELSE
			INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
			VALUES (NEW."id", NEW."node_id", "v_domain", NEW."enabled");
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 5. Managed storage names -----------------------------------------------------------------------------------------
-- Gives a cluster the first free "-2", "-3", ... suffix of its name on its node, renames its canonical connection
-- when that still mirrors the old name, and records the rename in the audit log. Same rule as 0207's one-time
-- deduplication; the runtime uses it when a cluster whose delete failed leaves 'deleting' after its name was reused,
-- so the cluster never stays in 'deleting'. Returns the new name (NULL for an unknown cluster).
CREATE OR REPLACE FUNCTION "managed_storage_cluster_take_free_name"("p_cluster_id" uuid, "p_reason" text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	"v_cluster" record;
	"v_candidate" text;
	"v_suffix" integer := 2;
BEGIN
	SELECT "cluster"."id", "cluster"."node_id", "cluster"."name", "cluster"."object_storage_connection_id"
	INTO "v_cluster"
	FROM "managed_storage_clusters" AS "cluster"
	WHERE "cluster"."id" = "p_cluster_id"
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	LOOP
		"v_candidate" := left("v_cluster"."name", 255 - length('-' || "v_suffix")) || '-' || "v_suffix";
		EXIT WHEN NOT EXISTS (
			SELECT 1 FROM "managed_storage_clusters" AS "other"
			WHERE "other"."node_id" = "v_cluster"."node_id"
				AND "other"."name" = "v_candidate"
				AND "other"."status" <> 'deleting'
				AND "other"."id" <> "v_cluster"."id"
		);
		"v_suffix" := "v_suffix" + 1;
	END LOOP;
	UPDATE "managed_storage_clusters" SET "name" = "v_candidate", "updated_at" = now() WHERE "id" = "v_cluster"."id";
	UPDATE "object_storage_connections" SET "name" = "v_candidate", "updated_at" = now()
	WHERE "id" = "v_cluster"."object_storage_connection_id" AND "name" = "v_cluster"."name";
	INSERT INTO "audit_log" ("action", "resource_type", "resource_id", "details")
	VALUES (
		'storage.managed.renamed_duplicate',
		'managed_storage_cluster',
		"v_cluster"."id"::text,
		jsonb_build_object(
			'previousName', "v_cluster"."name",
			'name', "v_candidate",
			'nodeId', "v_cluster"."node_id",
			'reason', "p_reason"
		)
	);
	RAISE WARNING 'Managed storage cluster % renamed from "%" to "%": the name is already used on node %',
		"v_cluster"."id", "v_cluster"."name", "v_candidate", "v_cluster"."node_id";
	RETURN "v_candidate";
END;
$$;
