-- Docker webhooks record the account that created them and the account that last changed them (enable, disable or
-- token rotation). A webhook call that gives a workload with host bind mounts a new image acts for the account that
-- last changed the webhook, checked against its current docker:containers:mounts permission. Webhooks saved before
-- this column have no recorded account, so they stay refused on host-bind workloads until someone saves them again.
ALTER TABLE "docker_webhooks" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_webhooks" ADD COLUMN "updated_by_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_webhooks" ADD CONSTRAINT "docker_webhooks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_webhooks" ADD CONSTRAINT "docker_webhooks_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
