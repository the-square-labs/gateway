ALTER TABLE "database_connections" ADD COLUMN "tls_verify_certificate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "tls_ca_certificate" text;--> statement-breakpoint
-- Connections created before certificate verification existed keep working: external PostgreSQL and Redis
-- over TLS never verified the server certificate, so they start explicitly unverified (ClickHouse already
-- verified; managed databases verify against the Gateway Database CA regardless of this column).
UPDATE "database_connections" AS dc
SET "tls_verify_certificate" = false
WHERE dc."tls_enabled" = true
  AND dc."type" IN ('postgres', 'redis')
  AND NOT EXISTS (
    SELECT 1 FROM "managed_database_instances" AS mdi
    WHERE mdi."database_connection_id" = dc."id"
  );
