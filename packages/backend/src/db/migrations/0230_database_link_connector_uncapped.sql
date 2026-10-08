-- The shared connector no longer caps a managed database link at 16 concurrent connections: the daemon holds the link
-- at its grant's limit, which follows the database's max_connections, and the relay at the route's. Stored database
-- link routes get maxSessions 0, as storage and container links have. No route generation moves: the connector
-- applies the new egress to its running listener, so no open connection drops. The policy revision advances once
-- when a route changed, so every relay and daemon takes it with its next snapshot and grants.
WITH "uncapped" AS (
  UPDATE "relay_routes"
  SET "secure_link_egress" = jsonb_set("secure_link_egress", '{maxSessions}', '0'::jsonb), "updated_at" = now()
  WHERE "owner_kind" = 'managed_database_binding'
    AND jsonb_typeof("secure_link_egress") = 'object'
    AND COALESCE("secure_link_egress"->'maxSessions', '0'::jsonb) <> '0'::jsonb
  RETURNING 1
)
UPDATE "relay_policy_state"
SET "revision" = "revision" + 1,
    "updated_at" = now()
WHERE "id" = 'current' AND EXISTS (SELECT 1 FROM "uncapped");
