CREATE TABLE "ssl_certificate_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD CONSTRAINT "ssl_certificate_folders_parent_id_ssl_certificate_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ssl_certificate_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD CONSTRAINT "ssl_certificate_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssl_certificate_folder_parent_idx" ON "ssl_certificate_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ssl_certificate_folder_sort_idx" ON "ssl_certificate_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD CONSTRAINT "ssl_certificates_folder_id_ssl_certificate_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."ssl_certificate_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssl_cert_folder_idx" ON "ssl_certificates" USING btree ("folder_id");