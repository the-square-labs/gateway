UPDATE "permission_groups"
SET "scopes" = "scopes" || '["ai:workspace:use"]'::jsonb
WHERE "scopes" ? 'feat:ai:use'
  AND NOT ("scopes" ? 'ai:workspace:use');
--> statement-breakpoint
UPDATE "users"
SET "additional_scopes" = "additional_scopes" || '["ai:workspace:use"]'::jsonb
WHERE "additional_scopes" ? 'feat:ai:use'
  AND NOT ("additional_scopes" ? 'ai:workspace:use');
