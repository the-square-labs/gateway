ALTER TYPE "public"."system_certificate_lifecycle_state" ADD VALUE IF NOT EXISTS 'pending';--> statement-breakpoint
ALTER TABLE "backup_runs" DROP CONSTRAINT "backup_runs_database_connection_id_database_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "backup_runs" ALTER COLUMN "database_connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "database_connection_name" text;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificate_authorities" ADD COLUMN "last_crl_der" text;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "postgres_query_principal_version" integer;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "encrypted_query_writer_credentials" text;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "postgres_query_writer_version" integer;--> statement-breakpoint
ALTER TABLE "nginx_certificate_replicas" ADD COLUMN "repair_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "enrollment_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pending_certificate_serial" varchar(255);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pending_certificate_fingerprint" varchar(71);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pending_certificate_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD COLUMN "renewal_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD COLUMN "last_renewal_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_issuer" varchar(2048);--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_database_connection_id_database_connections_id_fk" FOREIGN KEY ("database_connection_id") REFERENCES "public"."database_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "relay_policy_signing_keys"
SET "status" = 'verification_only', "verify_until" = now() + interval '30 minutes'
WHERE "status" = 'active'
  AND "id" <> (
    SELECT "id" FROM "relay_policy_signing_keys" WHERE "status" = 'active'
    ORDER BY "activated_at" DESC NULLS LAST, "created_at" DESC LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX "relay_policy_signing_keys_single_active_idx" ON "relay_policy_signing_keys" USING btree ("status") WHERE "relay_policy_signing_keys"."status" = 'active';--> statement-breakpoint
UPDATE "ssl_certificates" SET "status" = 'active', "updated_at" = now()
WHERE "status" = 'error' AND "type" = 'acme' AND "not_after" > now()
  AND "certificate_pem" IS NOT NULL AND "renewal_error" LIKE 'Renewal failed:%';--> statement-breakpoint
UPDATE "users" SET "oidc_issuer" = rtrim(s."value"->>'issuer', '/')
FROM "settings" s
WHERE s."key" = 'auth:oidc' AND "users"."auth_method" = 'oidc' AND "users"."oidc_issuer" IS NULL
  AND "users"."oidc_subject" IS NOT NULL
  AND "users"."oidc_subject" NOT LIKE 'manual:%' AND "users"."oidc_subject" NOT LIKE 'system:%'
  AND coalesce(s."value"->>'issuer', '') <> '';--> statement-breakpoint
UPDATE "notification_alert_rules"
SET "duration_seconds" = 0, "fire_threshold_percent" = 100, "resolve_after_seconds" = 0,
    "resolve_threshold_percent" = 100, "updated_at" = now()
WHERE "type" = 'threshold' AND "category" = 'certificate' AND "metric" = 'days_until_expiry'
  AND (coalesce("duration_seconds", 0) <> 0 OR coalesce("resolve_after_seconds", 0) <> 0
    OR "fire_threshold_percent" <> 100 OR "resolve_threshold_percent" <> 100);--> statement-breakpoint
UPDATE "backup_runs" r SET "database_connection_name" = c."name"
FROM "database_connections" c
WHERE c."id" = r."database_connection_id" AND r."database_connection_name" IS NULL;--> statement-breakpoint
UPDATE "backup_runs" r SET "deadline_at" = l."expires_at" + interval '5 minutes'
FROM "backup_run_node_leases" l
WHERE l."run_id" = r."id" AND r."deadline_at" IS NULL AND r."status" IN ('queued', 'running');--> statement-breakpoint
UPDATE "nodes" SET "enrollment_token_expires_at" = now() + interval '7 days'
WHERE "status" = 'pending' AND "enrollment_token_hash" IS NOT NULL AND "enrollment_token_expires_at" IS NULL;
