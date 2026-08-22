ALTER TABLE "inference_models" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ordered_models AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "public_id", "id") - 1 AS "sort_order"
  FROM "inference_models"
)
UPDATE "inference_models"
SET "sort_order" = ordered_models."sort_order"
FROM ordered_models
WHERE "inference_models"."id" = ordered_models."id";--> statement-breakpoint
CREATE INDEX "inference_models_sort_order_idx" ON "inference_models" USING btree ("sort_order");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "gateway_migrate_scope_array"("source_scopes" jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg("scope" ORDER BY "scope"), '[]'::jsonb)
  FROM (
    SELECT DISTINCT "scope"
    FROM jsonb_array_elements_text(COALESCE("source_scopes", '[]'::jsonb)) AS existing("value")
    CROSS JOIN LATERAL (
      SELECT 'integrations:cloudflare:view' AS "scope"
      WHERE existing."value" IN (
        'integrations:cloudflare:dns:view',
        'integrations:cloudflare:dns:edit',
        'integrations:cloudflare:dns:delete'
      )
      UNION ALL
      SELECT 'docker:containers:files:read'
      WHERE existing."value" = 'docker:containers:files'
      UNION ALL
      SELECT 'docker:containers:files:write'
      WHERE existing."value" = 'docker:containers:files'
      UNION ALL
      SELECT 'docker:containers:files:read:' || substr(existing."value", length('docker:containers:files:') + 1)
      WHERE existing."value" LIKE 'docker:containers:files:%'
        AND existing."value" <> 'docker:containers:files:read'
        AND existing."value" <> 'docker:containers:files:write'
        AND existing."value" NOT LIKE 'docker:containers:files:read:%'
        AND existing."value" NOT LIKE 'docker:containers:files:write:%'
      UNION ALL
      SELECT 'docker:containers:files:write:' || substr(existing."value", length('docker:containers:files:') + 1)
      WHERE existing."value" LIKE 'docker:containers:files:%'
        AND existing."value" <> 'docker:containers:files:read'
        AND existing."value" <> 'docker:containers:files:write'
        AND existing."value" NOT LIKE 'docker:containers:files:read:%'
        AND existing."value" NOT LIKE 'docker:containers:files:write:%'
      UNION ALL
      SELECT existing."value"
      WHERE existing."value" NOT IN (
        'integrations:cloudflare:dns:view',
        'integrations:cloudflare:dns:edit',
        'integrations:cloudflare:dns:delete',
        'docker:containers:files'
      )
        AND existing."value" NOT LIKE 'docker:containers:files:%'
      UNION ALL
      SELECT existing."value"
      WHERE existing."value" IN ('docker:containers:files:read', 'docker:containers:files:write')
         OR existing."value" LIKE 'docker:containers:files:read:%'
         OR existing."value" LIKE 'docker:containers:files:write:%'
    ) migrated
  ) deduplicated;
$$;--> statement-breakpoint

UPDATE "permission_groups" SET "scopes" = "gateway_migrate_scope_array"("scopes");--> statement-breakpoint
UPDATE "users" SET "additional_scopes" = "gateway_migrate_scope_array"("additional_scopes");--> statement-breakpoint
UPDATE "api_tokens" SET "scopes" = "gateway_migrate_scope_array"("scopes");--> statement-breakpoint
UPDATE "oauth_authorization_codes"
SET "requested_scopes" = "gateway_migrate_scope_array"("requested_scopes"),
    "scopes" = "gateway_migrate_scope_array"("scopes");--> statement-breakpoint
UPDATE "oauth_refresh_tokens" SET "scopes" = "gateway_migrate_scope_array"("scopes");--> statement-breakpoint
UPDATE "oauth_access_tokens" SET "scopes" = "gateway_migrate_scope_array"("scopes");--> statement-breakpoint
DROP FUNCTION "gateway_migrate_scope_array"(jsonb);
