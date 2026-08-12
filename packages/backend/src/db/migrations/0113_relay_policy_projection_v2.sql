-- The v2 proxy projection derives a 1024-session limit instead of serializing
-- the legacy per-row value. Advance the durable revision exactly once so an
-- existing relay can accept the changed snapshot digest.
UPDATE "relay_policy_state"
SET "revision" = "revision" + 1,
    "updated_at" = now()
WHERE "id" = 'current';
