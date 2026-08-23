UPDATE "permission_groups"
SET "scopes" = COALESCE(
  (
    SELECT jsonb_agg(scope_value)
    FROM jsonb_array_elements_text("permission_groups"."scopes") AS entries(scope_value)
    WHERE scope_value <> 'inference:setup' AND scope_value NOT LIKE 'inference:setup:%'
  ),
  '[]'::jsonb
)
WHERE "scopes" ? 'inference:setup'
   OR EXISTS (
     SELECT 1
     FROM jsonb_array_elements_text("permission_groups"."scopes") AS entries(scope_value)
     WHERE scope_value LIKE 'inference:setup:%'
   );
--> statement-breakpoint
UPDATE "users"
SET "additional_scopes" = COALESCE(
  (
    SELECT jsonb_agg(scope_value)
    FROM jsonb_array_elements_text("users"."additional_scopes") AS entries(scope_value)
    WHERE scope_value <> 'inference:setup' AND scope_value NOT LIKE 'inference:setup:%'
  ),
  '[]'::jsonb
)
WHERE "additional_scopes" ? 'inference:setup'
   OR EXISTS (
     SELECT 1
     FROM jsonb_array_elements_text("users"."additional_scopes") AS entries(scope_value)
     WHERE scope_value LIKE 'inference:setup:%'
   );
--> statement-breakpoint
UPDATE "api_tokens"
SET "scopes" = COALESCE(
  (
    SELECT jsonb_agg(scope_value)
    FROM jsonb_array_elements_text("api_tokens"."scopes") AS entries(scope_value)
    WHERE scope_value <> 'inference:setup' AND scope_value NOT LIKE 'inference:setup:%'
  ),
  '[]'::jsonb
)
WHERE "scopes" ? 'inference:setup'
   OR EXISTS (
     SELECT 1
     FROM jsonb_array_elements_text("api_tokens"."scopes") AS entries(scope_value)
     WHERE scope_value LIKE 'inference:setup:%'
   );
