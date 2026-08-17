CREATE OR REPLACE FUNCTION gateway_collapse_gitlab_registry_view(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(normalized.scope ORDER BY normalized.first_position), '[]'::jsonb)
  FROM (
    SELECT
      CASE
        WHEN entry.value = 'integrations:gitlab:registry:view'
          THEN 'docker:registries:view'
        ELSE entry.value
      END AS scope,
      MIN(entry.position) AS first_position
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb))
      WITH ORDINALITY AS entry(value, position)
    GROUP BY
      CASE
        WHEN entry.value = 'integrations:gitlab:registry:view'
          THEN 'docker:registries:view'
        ELSE entry.value
      END
  ) AS normalized;
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_collapse_gitlab_registry_view("scopes")
WHERE "scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_collapse_gitlab_registry_view("additional_scopes")
WHERE "additional_scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = gateway_collapse_gitlab_registry_view("scopes")
WHERE "scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = gateway_collapse_gitlab_registry_view("requested_scopes"),
  "scopes" = gateway_collapse_gitlab_registry_view("scopes")
WHERE
  "requested_scopes" ? 'integrations:gitlab:registry:view'
  OR "scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = gateway_collapse_gitlab_registry_view("scopes")
WHERE "scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = gateway_collapse_gitlab_registry_view("scopes")
WHERE "scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "ai_run_tool_calls"
SET "required_scopes" = gateway_collapse_gitlab_registry_view("required_scopes")
WHERE "required_scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

UPDATE "sandbox_jobs"
SET "required_scopes" = gateway_collapse_gitlab_registry_view("required_scopes")
WHERE "required_scopes" ? 'integrations:gitlab:registry:view';--> statement-breakpoint

DROP FUNCTION gateway_collapse_gitlab_registry_view(jsonb);
