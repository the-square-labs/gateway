CREATE OR REPLACE FUNCTION gateway_collapse_inference_token_permissions(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(normalized.scope ORDER BY normalized.first_position), '[]'::jsonb)
  FROM (
    SELECT
      CASE
        WHEN entry.value IN ('inference:tokens:create', 'inference:tokens:revoke')
          THEN 'inference:tokens:manage'
        ELSE entry.value
      END AS scope,
      MIN(entry.position) AS first_position
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb))
      WITH ORDINALITY AS entry(value, position)
    GROUP BY
      CASE
        WHEN entry.value IN ('inference:tokens:create', 'inference:tokens:revoke')
          THEN 'inference:tokens:manage'
        ELSE entry.value
      END
  ) AS normalized;
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_collapse_inference_token_permissions("scopes")
WHERE "scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_collapse_inference_token_permissions("additional_scopes")
WHERE "additional_scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = gateway_collapse_inference_token_permissions("scopes")
WHERE "scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = gateway_collapse_inference_token_permissions("requested_scopes"),
  "scopes" = gateway_collapse_inference_token_permissions("scopes")
WHERE
  "requested_scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke']
  OR "scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = gateway_collapse_inference_token_permissions("scopes")
WHERE "scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = gateway_collapse_inference_token_permissions("scopes")
WHERE "scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "ai_run_tool_calls"
SET "required_scopes" = gateway_collapse_inference_token_permissions("required_scopes")
WHERE "required_scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

UPDATE "sandbox_jobs"
SET "required_scopes" = gateway_collapse_inference_token_permissions("required_scopes")
WHERE "required_scopes" ?| ARRAY['inference:tokens:create', 'inference:tokens:revoke'];--> statement-breakpoint

DROP FUNCTION gateway_collapse_inference_token_permissions(jsonb);
