-- v2.11 scope catalog cleanup. Rewrites every stored scope array to the current catalog:
-- retired names map to their replacements with resource, folder, and node qualifiers preserved
-- (`old:<suffix>` -> `new:<suffix>`), and removed scopes are dropped. Holders of a few scopes whose
-- capabilities moved to new scopes receive those scopes so nobody loses effective access; resource and
-- bare Docker node qualifiers are kept, folder and node destinations receive nothing.
-- The mapping mirrors packages/backend/src/lib/scopes-aliases.ts. Re-running is a no-op.
CREATE OR REPLACE FUNCTION gateway_scope_catalog_cleanup_0200(scopes jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  WITH retired(old_scope, new_scope) AS (
    VALUES
      ('ssl:cert:revoke', NULL::text),
      ('ssl:cert:export', NULL),
      ('notifications:view', 'notifications:alerts:view'),
      ('notifications:view', 'notifications:webhooks:view'),
      ('notifications:manage', 'notifications:alerts:manage'),
      ('notifications:manage', 'notifications:webhooks:manage'),
      ('notifications:alerts:create', 'notifications:alerts:manage'),
      ('notifications:alerts:edit', 'notifications:alerts:manage'),
      ('notifications:alerts:delete', 'notifications:alerts:manage'),
      ('notifications:webhooks:create', 'notifications:webhooks:manage'),
      ('notifications:webhooks:edit', 'notifications:webhooks:manage'),
      ('notifications:webhooks:delete', 'notifications:webhooks:manage'),
      ('notifications:deliveries:view', 'notifications:webhooks:view'),
      ('logs:manage', 'logs:environments:view'),
      ('logs:manage', 'logs:environments:create'),
      ('logs:manage', 'logs:environments:edit'),
      ('logs:manage', 'logs:environments:delete'),
      ('logs:manage', 'logs:environments:folders:manage'),
      ('logs:manage', 'logs:tokens:view'),
      ('logs:manage', 'logs:tokens:create'),
      ('logs:manage', 'logs:tokens:delete'),
      ('logs:manage', 'logs:schemas:view'),
      ('logs:manage', 'logs:schemas:create'),
      ('logs:manage', 'logs:schemas:edit'),
      ('logs:manage', 'logs:schemas:delete'),
      ('logs:manage', 'logs:schemas:folders:manage'),
      ('logs:manage', 'logs:read'),
      ('docker:containers:config', NULL),
      ('nodes:config:edit', 'nodes:manage'),
      ('pki:ca:view:root', 'pki:ca:view'),
      ('pki:ca:view:intermediate', 'pki:ca:view'),
      ('integrations:gitlab:sync', 'integrations:gitlab:manage'),
      ('integrations:gitlab:system', 'integrations:gitlab:use'),
      ('integrations:gitlab:projects:view', 'integrations:gitlab:view'),
      ('integrations:gitlab:ci:view', 'integrations:gitlab:repo:read'),
      ('integrations:gitlab:variables:view', 'integrations:gitlab:repo:read'),
      ('integrations:gitlab:ci:edit', 'integrations:gitlab:repo:write'),
      ('integrations:gitlab:variables:edit', 'integrations:gitlab:repo:write'),
      ('integrations:gitlab:variables:delete', 'integrations:gitlab:repo:write'),
      ('integrations:gitlab:webhooks:manage', 'integrations:gitlab:repo:write'),
      ('integrations:gitlab:registry:manage', 'integrations:gitlab:repo:write'),
      ('integrations:github:sync', 'integrations:github:manage'),
      ('integrations:github:system', 'integrations:github:use'),
      ('integrations:git:sync', 'integrations:git:manage'),
      ('integrations:git:system', 'integrations:git:use'),
      ('proxy:raw:toggle', NULL),
      ('proxy:advanced:bypass', 'proxy:unrestricted'),
      ('proxy:raw:bypass', 'proxy:unrestricted'),
      ('proxy:templates:create', 'proxy:templates:manage'),
      ('proxy:templates:edit', 'proxy:templates:manage'),
      ('proxy:templates:delete', 'proxy:templates:manage'),
      ('docker:containers:folders:manage', 'docker:folders:manage')
  ),
  additions(trigger_scope, new_scope) AS (
    VALUES
      ('pki:ca:create:root', 'pki:ca:edit'),
      ('pki:ca:create:root', 'pki:ca:export'),
      ('integrations:github:view', 'integrations:github:repo:read'),
      ('integrations:github:manage', 'integrations:github:repo:read'),
      ('integrations:github:manage', 'integrations:github:repo:write'),
      ('integrations:git:view', 'integrations:git:repo:read'),
      ('integrations:git:manage', 'integrations:git:repo:read'),
      ('integrations:git:manage', 'integrations:git:repo:write'),
      ('docker:volumes:create', 'docker:volumes:edit')
  ),
  entries AS (
    SELECT entry.value AS scope, entry.position
    FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb)) WITH ORDINALITY AS entry(value, position)
  ),
  matched AS (
    SELECT
      entries.scope,
      entries.position,
      (
        SELECT candidate.old_scope
        FROM (SELECT DISTINCT old_scope FROM retired) AS candidate
        WHERE entries.scope = candidate.old_scope
          OR left(entries.scope, length(candidate.old_scope) + 1) = candidate.old_scope || ':'
        ORDER BY length(candidate.old_scope) DESC
        LIMIT 1
      ) AS old_scope
    FROM entries
  ),
  renamed AS (
    SELECT matched.scope, matched.position, 0 AS rank
    FROM matched
    WHERE matched.old_scope IS NULL
    UNION ALL
    SELECT retired.new_scope || substr(matched.scope, length(matched.old_scope) + 1), matched.position, 1
    FROM matched
    JOIN retired ON retired.old_scope = matched.old_scope
    WHERE retired.new_scope IS NOT NULL
  ),
  -- Additions are computed from the renamed set, so a scope reached through an old name (for example
  -- integrations:github:sync -> manage) gets the same additions as the current name, and a second
  -- run adds nothing.
  added AS (
    SELECT
      additions.new_scope || substr(renamed.scope, length(additions.trigger_scope) + 1) AS scope,
      renamed.position
    FROM renamed
    JOIN additions
      ON renamed.scope = additions.trigger_scope
      OR (
        left(renamed.scope, length(additions.trigger_scope) + 1) = additions.trigger_scope || ':'
        -- Folder and node destinations never turn into grants on the resources already there.
        AND left(substr(renamed.scope, length(additions.trigger_scope) + 2), 7) <> 'folder/'
        AND left(substr(renamed.scope, length(additions.trigger_scope) + 2), 5) <> 'node/'
      )
  ),
  rewritten AS (
    SELECT renamed.scope, renamed.position, renamed.rank
    FROM renamed
    UNION ALL
    SELECT added.scope, added.position, 2
    FROM added
    WHERE NOT EXISTS (SELECT 1 FROM renamed AS existing WHERE existing.scope = added.scope)
  )
  SELECT COALESCE(jsonb_agg(normalized.scope ORDER BY normalized.first_position, normalized.first_rank, normalized.scope), '[]'::jsonb)
  FROM (
    SELECT rewritten.scope, MIN(rewritten.position) AS first_position, MIN(rewritten.rank) AS first_rank
    FROM rewritten
    GROUP BY rewritten.scope
  ) AS normalized;
$$;--> statement-breakpoint

UPDATE "permission_groups"
SET "scopes" = gateway_scope_catalog_cleanup_0200("scopes")
WHERE "scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("scopes");--> statement-breakpoint

UPDATE "users"
SET "additional_scopes" = gateway_scope_catalog_cleanup_0200("additional_scopes")
WHERE "additional_scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("additional_scopes");--> statement-breakpoint

UPDATE "api_tokens"
SET "scopes" = gateway_scope_catalog_cleanup_0200("scopes")
WHERE "scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("scopes");--> statement-breakpoint

UPDATE "oauth_authorization_codes"
SET
  "requested_scopes" = gateway_scope_catalog_cleanup_0200("requested_scopes"),
  "scopes" = gateway_scope_catalog_cleanup_0200("scopes")
WHERE
  "requested_scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("requested_scopes")
  OR "scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("scopes");--> statement-breakpoint

UPDATE "oauth_refresh_tokens"
SET "scopes" = gateway_scope_catalog_cleanup_0200("scopes")
WHERE "scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("scopes");--> statement-breakpoint

UPDATE "oauth_access_tokens"
SET "scopes" = gateway_scope_catalog_cleanup_0200("scopes")
WHERE "scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("scopes");--> statement-breakpoint

UPDATE "ai_run_tool_calls"
SET "required_scopes" = gateway_scope_catalog_cleanup_0200("required_scopes")
WHERE "required_scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("required_scopes");--> statement-breakpoint

UPDATE "sandbox_jobs"
SET "required_scopes" = gateway_scope_catalog_cleanup_0200("required_scopes")
WHERE "required_scopes" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("required_scopes");--> statement-breakpoint

DROP FUNCTION gateway_scope_catalog_cleanup_0200(jsonb);
