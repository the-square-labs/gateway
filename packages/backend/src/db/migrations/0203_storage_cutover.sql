-- Migration write freeze for managed storage (manage_managed_storage freeze_writes/unfreeze_writes).
ALTER TABLE "managed_storage_clusters" ADD COLUMN "writes_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD COLUMN "writes_frozen_by_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_writes_frozen_by_id_users_id_fk" FOREIGN KEY ("writes_frozen_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
