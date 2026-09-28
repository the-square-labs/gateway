CREATE TABLE "ingress_group_members" (
	"group_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"drain_started_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_group_members_pkey" PRIMARY KEY("group_id","node_id"),
	CONSTRAINT "ingress_group_members_state_valid" CHECK ("ingress_group_members"."state" IN ('joining', 'active', 'draining')),
	CONSTRAINT "ingress_group_members_drain_consistent" CHECK (("ingress_group_members"."state" = 'draining') = ("ingress_group_members"."drain_started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ingress_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"description" text,
	"folder_id" uuid,
	"dns_failover_mode" varchar(32) DEFAULT 'none' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_groups_slug_unique" UNIQUE("slug"),
	CONSTRAINT "ingress_groups_dns_failover_mode_valid" CHECK ("ingress_groups"."dns_failover_mode" IN ('none'))
);
--> statement-breakpoint
CREATE TABLE "ingress_member_deliveries" (
	"host_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"desired_config_hash" varchar(64),
	"applied_config_hash" varchar(64),
	"desired_certificate_version" varchar(128),
	"applied_certificate_version" varchar(128),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"attempted_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_member_deliveries_pkey" PRIMARY KEY("host_id","node_id"),
	CONSTRAINT "ingress_member_deliveries_status_check" CHECK ("ingress_member_deliveries"."status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "relay_routes" DROP CONSTRAINT "relay_routes_owner_unique";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_group_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "ingress_group_id" uuid;--> statement-breakpoint
ALTER TABLE "ingress_group_members" ADD CONSTRAINT "ingress_group_members_group_id_ingress_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."ingress_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_group_members" ADD CONSTRAINT "ingress_group_members_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_groups" ADD CONSTRAINT "ingress_groups_folder_id_node_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."node_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_groups" ADD CONSTRAINT "ingress_groups_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_member_deliveries" ADD CONSTRAINT "ingress_member_deliveries_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingress_group_members_node_idx" ON "ingress_group_members" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "ingress_group_members_order_idx" ON "ingress_group_members" USING btree ("group_id","priority");--> statement-breakpoint
CREATE INDEX "ingress_groups_folder_idx" ON "ingress_groups" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "ingress_member_deliveries_node_status_idx" ON "ingress_member_deliveries" USING btree ("node_id","status");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_ingress_group_id_ingress_groups_id_fk" FOREIGN KEY ("ingress_group_id") REFERENCES "public"."ingress_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD CONSTRAINT "proxy_hosts_ingress_group_id_ingress_groups_id_fk" FOREIGN KEY ("ingress_group_id") REFERENCES "public"."ingress_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_ingress_group_idx" ON "domains" USING btree ("ingress_group_id");--> statement-breakpoint
CREATE INDEX "proxy_host_ingress_group_idx" ON "proxy_hosts" USING btree ("ingress_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_owner_unique" ON "relay_routes" USING btree ("owner_kind","owner_id") WHERE "relay_routes"."owner_kind" <> 'proxy_host_secure_link';--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_proxy_link_source_unique" ON "relay_routes" USING btree ("owner_kind","owner_id","source_kind","source_id") WHERE "relay_routes"."owner_kind" = 'proxy_host_secure_link';--> statement-breakpoint
ALTER TABLE "proxy_host_domains" DROP CONSTRAINT "proxy_host_domains_pkey";
--> statement-breakpoint
ALTER TABLE "proxy_host_domains" ADD CONSTRAINT "proxy_host_domains_pkey" PRIMARY KEY("proxy_host_id","node_id","domain");--> statement-breakpoint

-- Ingress groups: a route served by a group owns one proxy_host_domains row per member node and name, so the per-node
-- unique index refuses a name that another enabled route already serves on any member. proxy_hosts.node_id of a
-- group route mirrors the group's first member; the member set comes from ingress_group_members.
CREATE OR REPLACE FUNCTION "proxy_host_serving_node_ids"("p_node_id" uuid, "p_group_id" uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN "p_group_id" IS NOT NULL THEN coalesce(
			(SELECT array_agg("member"."node_id" ORDER BY "member"."node_id")
				FROM "ingress_group_members" AS "member" WHERE "member"."group_id" = "p_group_id"),
			'{}'::uuid[])
		WHEN "p_node_id" IS NOT NULL THEN ARRAY["p_node_id"]
		ELSE '{}'::uuid[]
	END
$$;
--> statement-breakpoint
-- Same rules as migration 0209, per serving node: rows are rebuilt (and so checked against the unique index) when a
-- host's names, node or group change. When only `enabled` changes, each row keeps its legacy flag; in record mode a
-- name another enabled host serves is kept as a legacy conflict instead of refused.
CREATE OR REPLACE FUNCTION "proxy_hosts_domains_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	"v_record" boolean := coalesce(current_setting('gateway.proxy_domain_conflicts', true), '') = 'record';
	"v_nodes" uuid[] := "proxy_host_serving_node_ids"(NEW."node_id", NEW."ingress_group_id");
	"v_node" uuid;
	"v_domain" text;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."node_id" IS NOT DISTINCT FROM OLD."node_id"
			AND NEW."ingress_group_id" IS NOT DISTINCT FROM OLD."ingress_group_id"
			AND "proxy_host_normalized_domains"(NEW."domain_names") = "proxy_host_normalized_domains"(OLD."domain_names") THEN
			IF NEW."enabled" IS NOT DISTINCT FROM OLD."enabled" OR cardinality("v_nodes") = 0 THEN
				RETURN NULL;
			END IF;
			IF NOT NEW."enabled" OR NOT "v_record" THEN
				UPDATE "proxy_host_domains" SET "enabled" = NEW."enabled" WHERE "proxy_host_id" = NEW."id";
				RETURN NULL;
			END IF;
			FOR "v_node", "v_domain" IN
				SELECT "row"."node_id", "row"."domain" FROM "proxy_host_domains" AS "row"
				WHERE "row"."proxy_host_id" = NEW."id" ORDER BY 1, 2
			LOOP
				BEGIN
					UPDATE "proxy_host_domains" SET "enabled" = true
					WHERE "proxy_host_id" = NEW."id" AND "node_id" = "v_node" AND "domain" = "v_domain";
				EXCEPTION WHEN unique_violation THEN
					UPDATE "proxy_host_domains" SET "enabled" = true, "legacy_conflict" = true
					WHERE "proxy_host_id" = NEW."id" AND "node_id" = "v_node" AND "domain" = "v_domain";
				END;
			END LOOP;
			RETURN NULL;
		END IF;
	END IF;
	DELETE FROM "proxy_host_domains" WHERE "proxy_host_id" = NEW."id";
	FOREACH "v_node" IN ARRAY "v_nodes" LOOP
		FOREACH "v_domain" IN ARRAY "proxy_host_normalized_domains"(NEW."domain_names") LOOP
			IF "v_record" AND NEW."enabled" THEN
				BEGIN
					INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
					VALUES (NEW."id", "v_node", "v_domain", true);
				EXCEPTION WHEN unique_violation THEN
					INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled", "legacy_conflict")
					VALUES (NEW."id", "v_node", "v_domain", true, true);
				END;
			ELSE
				INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
				VALUES (NEW."id", "v_node", "v_domain", NEW."enabled");
			END IF;
		END LOOP;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "proxy_hosts_domains_sync" ON "proxy_hosts";
--> statement-breakpoint
CREATE TRIGGER "proxy_hosts_domains_sync"
AFTER INSERT OR UPDATE OF "domain_names", "enabled", "node_id", "ingress_group_id" ON "proxy_hosts"
FOR EACH ROW EXECUTE FUNCTION "proxy_hosts_domains_trigger"();
--> statement-breakpoint
-- A member joining a group gets the rows of every route of the group (refused when another enabled route already
-- serves one of the names on that node); a member leaving drops them.
CREATE OR REPLACE FUNCTION "ingress_group_members_domains_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	"v_host" record;
	"v_domain" text;
BEGIN
	IF TG_OP IN ('DELETE', 'UPDATE') THEN
		DELETE FROM "proxy_host_domains" AS "row"
		USING "proxy_hosts" AS "host"
		WHERE "row"."proxy_host_id" = "host"."id"
			AND "host"."ingress_group_id" = OLD."group_id"
			AND "row"."node_id" = OLD."node_id";
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		FOR "v_host" IN
			SELECT "host"."id", "host"."domain_names", "host"."enabled" FROM "proxy_hosts" AS "host"
			WHERE "host"."ingress_group_id" = NEW."group_id"
		LOOP
			FOREACH "v_domain" IN ARRAY "proxy_host_normalized_domains"("v_host"."domain_names") LOOP
				INSERT INTO "proxy_host_domains" ("proxy_host_id", "node_id", "domain", "enabled")
				VALUES ("v_host"."id", NEW."node_id", "v_domain", "v_host"."enabled")
				ON CONFLICT ("proxy_host_id", "node_id", "domain") DO NOTHING;
			END LOOP;
		END LOOP;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ingress_group_members_domains_sync" ON "ingress_group_members";
--> statement-breakpoint
CREATE TRIGGER "ingress_group_members_domains_sync"
AFTER INSERT OR DELETE OR UPDATE OF "group_id", "node_id" ON "ingress_group_members"
FOR EACH ROW EXECUTE FUNCTION "ingress_group_members_domains_trigger"();
