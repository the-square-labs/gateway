-- Gateway-side relay policy bookkeeping moves out of relay_instances. Snapshot builds wrote the revocation fence route
-- history (relay_instances.policy_routes) while holding the relay policy revision lock and a share lock on
-- relay_policy_state; pool reconciliation locks a relay_instances row and then bumps relay_policy_state, and Postgres
-- detected the deadlock. The new table has no foreign key to relay_instances for the same reason (a foreign key check
-- takes a key-share lock on the instance row); rows of removed relays are pruned by the revocation evaluator.
-- It also keeps the content key, revision and lease of the last snapshot built per relay, so an unchanged policy is no
-- longer rebuilt under a new revision on every sync. The route history keeps its content.
CREATE TABLE IF NOT EXISTS "relay_instance_policy_state" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot_key" varchar(64),
	"snapshot_revision" bigint,
	"snapshot_issued_at_unix" bigint,
	"snapshot_expires_at_unix" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "relay_instance_policy_state" ("instance_id", "routes")
SELECT "id", "policy_routes" FROM "relay_instances" WHERE "policy_routes" IS NOT NULL
ON CONFLICT ("instance_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "relay_instances" DROP COLUMN IF EXISTS "policy_routes";
