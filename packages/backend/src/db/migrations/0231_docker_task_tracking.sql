-- Docker tasks a node may still run when Gateway loses track of them (Gateway restarts, or the node's control stream
-- drops while an image pull or a container stop, restart, kill, update or recreate runs) stay active instead of
-- failing: a daemon update that waits for the node's tasks keeps waiting for them. Gateway settles them with the node
-- once it is connected again: `tracking` holds what tells their end, `command_id` the daemon command a pull runs as
-- (the daemon reports a pull's outcome by it), `detached_at` since when Gateway has lost track. Existing rows keep
-- NULLs, so a release before this one reads them as before.
ALTER TABLE "docker_tasks" ADD COLUMN "command_id" text;--> statement-breakpoint
ALTER TABLE "docker_tasks" ADD COLUMN "tracking" jsonb;--> statement-breakpoint
ALTER TABLE "docker_tasks" ADD COLUMN "detached_at" timestamp with time zone;
