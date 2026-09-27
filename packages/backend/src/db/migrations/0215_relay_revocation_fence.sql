-- Relay instances record the route tuples their policy snapshots carried. Gateway keeps a tuple until the relay
-- acknowledges a snapshot without it; a revoked tuple the relay does not acknowledge in time marks the relay stale for
-- that route, and daemons refuse the route through it. Relays tracked before this column start with an empty history.
ALTER TABLE "relay_instances" ADD COLUMN IF NOT EXISTS "policy_routes" jsonb;
