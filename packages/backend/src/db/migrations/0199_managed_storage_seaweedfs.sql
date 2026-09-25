CREATE TYPE "public"."managed_storage_engine" AS ENUM('minio', 'seaweedfs');--> statement-breakpoint
ALTER TYPE "public"."object_storage_provider" ADD VALUE 'seaweedfs';--> statement-breakpoint
ALTER TABLE "managed_storage_access_keys" ADD COLUMN "principal" varchar(128);--> statement-breakpoint
ALTER TABLE "managed_storage_bindings" ADD COLUMN "principal" varchar(128);--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD COLUMN "engine" "managed_storage_engine" DEFAULT 'minio' NOT NULL;