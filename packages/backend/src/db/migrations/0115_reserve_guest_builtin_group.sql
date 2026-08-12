-- Preserve a pre-existing custom group that used the previously unreserved
-- built-in name. Memberships reference the group ID and therefore remain
-- attached after the collision-safe rename.
UPDATE "permission_groups"
SET
  "name" = 'guest-custom-' || "id"::text,
  "updated_at" = now()
WHERE "name" = 'guest' AND "is_builtin" = false;
