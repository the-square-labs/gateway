ALTER TABLE "managed_database_bindings" DROP CONSTRAINT "managed_database_bindings_managed_database_id_managed_database_instances_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "pending_encrypted_credentials" text;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "principal_name" varchar(128);--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "principal_model_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "principal_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "desired_state" varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "observed_state" varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "binding_identity_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "application_principal_name" varchar(128);--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "owner_separation_state" varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "owner_separation_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "encrypted_pending_owner_credentials" text;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "direct_principal_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD CONSTRAINT "managed_database_bindings_managed_database_id_managed_database_instances_id_fk" FOREIGN KEY ("managed_database_id") REFERENCES "public"."managed_database_instances"("id") ON DELETE restrict ON UPDATE no action;