CREATE OR REPLACE FUNCTION gateway_merge_inference_tokens_into_ai_use(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(normalized.scope ORDER BY normalized.first_position), '[]'::jsonb)
  FROM (
    SELECT
      CASE WHEN entry.value = 'inference:tokens:manage' THEN 'feat:ai:use' ELSE entry.value END AS scope,
      MIN(entry.position) AS first_position
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb))
      WITH ORDINALITY AS entry(value, position)
    GROUP BY CASE WHEN entry.value = 'inference:tokens:manage' THEN 'feat:ai:use' ELSE entry.value END
  ) AS normalized;
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_merge_inference_tokens_into_ai_use("scopes")
WHERE "scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_merge_inference_tokens_into_ai_use("additional_scopes")
WHERE "additional_scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:tokens:manage'
WHERE "scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = COALESCE("requested_scopes", '[]'::jsonb) - 'inference:tokens:manage',
  "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:tokens:manage'
WHERE "requested_scopes" ? 'inference:tokens:manage' OR "scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:tokens:manage'
WHERE "scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:tokens:manage'
WHERE "scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "ai_run_tool_calls"
SET "required_scopes" = gateway_merge_inference_tokens_into_ai_use("required_scopes")
WHERE "required_scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "sandbox_jobs"
SET "required_scopes" = gateway_merge_inference_tokens_into_ai_use("required_scopes")
WHERE "required_scopes" ? 'inference:tokens:manage';--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = "scopes" || '["ai:workspace:use"]'::jsonb
WHERE "name" IN ('viewer', 'operator', 'admin', 'system-admin')
  AND NOT ("scopes" ? 'ai:workspace:use');--> statement-breakpoint

DROP FUNCTION gateway_merge_inference_tokens_into_ai_use(jsonb);
