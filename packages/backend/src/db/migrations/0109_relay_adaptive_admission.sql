UPDATE "relay_policy_state"
SET "revision" = "revision" + 1, "updated_at" = now()
WHERE "id" = 'current';
