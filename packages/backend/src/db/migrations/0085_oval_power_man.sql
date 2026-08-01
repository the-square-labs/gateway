CREATE TYPE "public"."system_ca_purpose" AS ENUM('node-mtls', 'database-tls');--> statement-breakpoint
ALTER TABLE "certificate_authorities" ADD COLUMN "system_purpose" "system_ca_purpose";--> statement-breakpoint
UPDATE "certificate_authorities" SET "system_purpose" = 'node-mtls' WHERE "is_system" = true AND "system_purpose" IS NULL;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "tls_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "published_native_port" integer;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD CONSTRAINT "managed_database_instances_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ca_system_purpose_unique" ON "certificate_authorities" USING btree ("system_purpose");
