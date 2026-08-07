ALTER TYPE "public"."system_certificate_owner_type" ADD VALUE 'gateway_service';--> statement-breakpoint
CREATE VIEW "public"."gateway_relay_node_identities_v1" WITH (security_barrier = true) AS
SELECT
  "id" AS "node_id",
  "type"::text AS "node_type",
  "status"::text AS "node_status",
  "certificate_serial"
FROM "public"."nodes";--> statement-breakpoint
CREATE VIEW "public"."gateway_relay_managed_databases_v1" WITH (security_barrier = true) AS
SELECT
  "id" AS "managed_database_id",
  "node_id" AS "database_node_id",
  "status"::text AS "database_status"
FROM "public"."managed_database_instances";--> statement-breakpoint
CREATE VIEW "public"."gateway_relay_bindings_v1" WITH (security_barrier = true) AS
SELECT
  binding."id" AS "binding_id",
  binding."managed_database_id",
  binding."target_node_id" AS "source_node_id",
  binding."status"::text AS "binding_status",
  managed."node_id" AS "database_node_id",
  managed."status"::text AS "database_status"
FROM "public"."managed_database_bindings" binding
INNER JOIN "public"."managed_database_instances" managed
  ON managed."id" = binding."managed_database_id";
