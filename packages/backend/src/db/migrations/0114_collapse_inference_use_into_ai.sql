CREATE OR REPLACE FUNCTION gateway_collapse_inference_use_into_ai(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(normalized.scope ORDER BY normalized.first_position), '[]'::jsonb)
  FROM (
    SELECT
      CASE
        WHEN entry.value IN ('inference:use', 'inference:usage:view:self')
          THEN 'feat:ai:use'
        ELSE entry.value
      END AS scope,
      MIN(entry.position) AS first_position
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb))
      WITH ORDINALITY AS entry(value, position)
    GROUP BY
      CASE
        WHEN entry.value IN ('inference:use', 'inference:usage:view:self')
          THEN 'feat:ai:use'
        ELSE entry.value
      END
  ) AS normalized;
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_collapse_inference_use_into_ai("scopes")
WHERE "scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_collapse_inference_use_into_ai("additional_scopes")
WHERE "additional_scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:use' - 'inference:usage:view:self'
WHERE "scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = COALESCE("requested_scopes", '[]'::jsonb)
    - 'inference:use'
    - 'inference:usage:view:self',
  "scopes" = COALESCE("scopes", '[]'::jsonb)
    - 'inference:use'
    - 'inference:usage:view:self'
WHERE
  "requested_scopes" ?| ARRAY['inference:use', 'inference:usage:view:self']
  OR "scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:use' - 'inference:usage:view:self'
WHERE "scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = COALESCE("scopes", '[]'::jsonb) - 'inference:use' - 'inference:usage:view:self'
WHERE "scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "ai_run_tool_calls"
SET "required_scopes" = gateway_collapse_inference_use_into_ai("required_scopes")
WHERE "required_scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

UPDATE "sandbox_jobs"
SET "required_scopes" = gateway_collapse_inference_use_into_ai("required_scopes")
WHERE "required_scopes" ?| ARRAY['inference:use', 'inference:usage:view:self'];--> statement-breakpoint

DROP FUNCTION gateway_collapse_inference_use_into_ai(jsonb);
