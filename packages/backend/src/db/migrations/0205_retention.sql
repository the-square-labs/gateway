-- Linked internal PKI certificates used to be stored with auto-renewal off, so their proxy hosts broke when the leaf
-- expired. Gateway now reissues a linked leaf from the same CA and template before expiry whenever it holds the
-- private key. Enable that for existing links that carry a key; CSR-issued links (no key) keep expiry alerts only.
UPDATE "ssl_certificates"
SET "auto_renew" = true, "updated_at" = now()
WHERE "type" = 'internal'
  AND "auto_renew" = false
  AND "internal_cert_id" IS NOT NULL
  AND "private_key_pem" IS NOT NULL;
--> statement-breakpoint
-- Expiry alerts are raised once per resource, threshold and validity period. The marker outlives the alert row, which
-- housekeeping deletes after the dismissed-alert retention.
CREATE TABLE IF NOT EXISTS "expiry_alert_markers" (
  "resource_type" varchar(50) NOT NULL,
  "resource_id" uuid NOT NULL,
  "reason" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expiry_alert_markers_pkey" PRIMARY KEY("resource_type","resource_id","reason","expires_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expiry_alert_markers_expires_idx" ON "expiry_alert_markers" USING btree ("expires_at");
--> statement-breakpoint
-- Housekeeping only removes OAuth client registrations that never completed authorization. Record the last grant, and
-- backfill it from the grants issued so far (none of them were ever purged before this release).
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "last_grant_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "oauth_clients" AS "client"
SET "last_grant_at" = "grants"."last_grant_at"
FROM (
  SELECT "client_id", max("created_at") AS "last_grant_at"
  FROM (
    SELECT "client_id", "created_at" FROM "oauth_authorization_codes"
    UNION ALL
    SELECT "client_id", "created_at" FROM "oauth_refresh_tokens"
    UNION ALL
    SELECT "client_id", "created_at" FROM "oauth_access_tokens"
  ) AS "issued"
  GROUP BY "client_id"
) AS "grants"
WHERE "grants"."client_id" = "client"."client_id"
  AND "client"."last_grant_at" IS NULL;
