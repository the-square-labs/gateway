ALTER TYPE "proxy_upstream_kind" ADD VALUE IF NOT EXISTS 'managed_storage';
--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "managed_storage_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_managed_storage_id_managed_storage_clusters_id_fk" FOREIGN KEY ("managed_storage_id") REFERENCES "public"."managed_storage_clusters"("id") ON DELETE restrict ON UPDATE no action;
