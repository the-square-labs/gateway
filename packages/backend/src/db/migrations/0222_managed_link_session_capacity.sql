-- Managed database links and storage links now allow 64 concurrent relay sessions instead of the
-- per-row default of 16 (MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS). The limit is derived, so no
-- route row changes and no route generation moves: a generation change would recreate the daemon
-- listeners and drop every open connection. Advance the durable revision exactly once so every
-- relay takes the changed snapshot and every daemon gets grants carrying the new limit.
UPDATE "relay_policy_state"
SET "revision" = "revision" + 1,
    "updated_at" = now()
WHERE "id" = 'current';
