-- Ingress groups get their own permissions (ingress:groups:view, ingress:groups:manage) instead of node scopes.
-- Every stored grant keeps the ingress group access it had: broad or folder nodes:details and nodes:manage gain
-- ingress:groups:view with the same qualifier (`folder/<id>`), nodes:manage also ingress:groups:manage. Node grants
-- (`nodes:*:<nodeId>`) never covered a group and gain nothing. Built-in groups take their scopes from code at
-- startup and are skipped. The mapping mirrors packages/backend/src/lib/ingress-group-scope-mirror.ts. Re-running is
-- a no-op.
CREATE OR REPLACE FUNCTION gateway_ingress_group_scopes_0228(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  WITH mirror(source_scope, new_scope) AS (
    VALUES
      ('nodes:details', 'ingress:groups:view'),
      ('nodes:manage', 'ingress:groups:view'),
      ('nodes:manage', 'ingress:groups:manage')
  ),
  entries AS (
    SELECT entry.value AS scope
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb)) AS entry(value)
  ),
  added AS (
    SELECT DISTINCT mirror.new_scope || substr(entries.scope, length(mirror.source_scope) + 1) AS scope
    FROM entries
    JOIN mirror
      ON entries.scope = mirror.source_scope
      OR (
        left(entries.scope, length(mirror.source_scope) + 8) = mirror.source_scope || ':folder/'
        AND length(entries.scope) > length(mirror.source_scope) + 8
        AND strpos(substr(entries.scope, length(mirror.source_scope) + 9), '/') = 0
      )
  )
  SELECT COALESCE(scopes, '[]'::jsonb) || COALESCE(
    (
      SELECT jsonb_agg(added.scope ORDER BY added.scope)
      FROM added
      WHERE NOT (COALESCE(scopes, '[]'::jsonb) ? added.scope)
    ),
    '[]'::jsonb
  );
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_ingress_group_scopes_0228("scopes"), "updated_at" = now()
WHERE NOT "is_builtin"
  AND "scopes"::text LIKE '%"nodes:%'
  AND "scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("scopes");--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_ingress_group_scopes_0228("additional_scopes"), "updated_at" = now()
WHERE "additional_scopes"::text LIKE '%"nodes:%'
  AND "additional_scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("additional_scopes");--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = gateway_ingress_group_scopes_0228("scopes")
WHERE "scopes"::text LIKE '%"nodes:%'
  AND "scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("scopes");--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = gateway_ingress_group_scopes_0228("requested_scopes"),
  "scopes" = gateway_ingress_group_scopes_0228("scopes")
WHERE
  "requested_scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("requested_scopes")
  OR "scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("scopes");--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = gateway_ingress_group_scopes_0228("scopes")
WHERE "scopes"::text LIKE '%"nodes:%'
  AND "scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("scopes");--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = gateway_ingress_group_scopes_0228("scopes")
WHERE "scopes"::text LIKE '%"nodes:%'
  AND "scopes" IS DISTINCT FROM gateway_ingress_group_scopes_0228("scopes");--> statement-breakpoint

DROP FUNCTION gateway_ingress_group_scopes_0228(jsonb);
