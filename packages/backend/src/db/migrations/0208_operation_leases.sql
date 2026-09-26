-- Operation leases make ACME operations and container rename, update and migration-admission claims exclusive across
-- backend processes. They were kept in `settings` rows (keys 'operation-lease:*') before this table; those rows only
-- live for a lease's minute-long lifetime and are dropped, not migrated: a lease that was live lapses as it would
-- have, and its holder's compare-and-set writes still protect the resource.
CREATE TABLE IF NOT EXISTS "operation_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"token" uuid NOT NULL,
	"holder" text NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operation_leases_expires_at_idx" ON "operation_leases" USING btree ("expires_at");
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" LIKE 'operation-lease:%';
