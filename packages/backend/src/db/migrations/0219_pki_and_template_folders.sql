CREATE TABLE "nginx_template_folders" (
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
CREATE TABLE "pki_ca_folders" (
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
CREATE TABLE "pki_certificate_folders" (
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
CREATE TABLE "pki_template_folders" (
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
ALTER TABLE "certificate_authorities" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "certificate_authorities" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nginx_templates" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "nginx_templates" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nginx_template_folders" ADD CONSTRAINT "nginx_template_folders_parent_id_nginx_template_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nginx_template_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nginx_template_folders" ADD CONSTRAINT "nginx_template_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_ca_folders" ADD CONSTRAINT "pki_ca_folders_parent_id_pki_ca_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pki_ca_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_ca_folders" ADD CONSTRAINT "pki_ca_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_certificate_folders" ADD CONSTRAINT "pki_certificate_folders_parent_id_pki_certificate_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pki_certificate_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_certificate_folders" ADD CONSTRAINT "pki_certificate_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_template_folders" ADD CONSTRAINT "pki_template_folders_parent_id_pki_template_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pki_template_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_template_folders" ADD CONSTRAINT "pki_template_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nginx_template_folder_parent_idx" ON "nginx_template_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "nginx_template_folder_sort_idx" ON "nginx_template_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "pki_ca_folder_parent_idx" ON "pki_ca_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pki_ca_folder_sort_idx" ON "pki_ca_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "pki_certificate_folder_parent_idx" ON "pki_certificate_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pki_certificate_folder_sort_idx" ON "pki_certificate_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "pki_template_folder_parent_idx" ON "pki_template_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pki_template_folder_sort_idx" ON "pki_template_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
ALTER TABLE "certificate_authorities" ADD CONSTRAINT "certificate_authorities_folder_id_pki_ca_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."pki_ca_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_folder_id_pki_template_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."pki_template_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_folder_id_pki_certificate_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."pki_certificate_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nginx_templates" ADD CONSTRAINT "nginx_templates_folder_id_nginx_template_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."nginx_template_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ca_folder_idx" ON "certificate_authorities" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "cert_template_folder_idx" ON "certificate_templates" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "cert_folder_idx" ON "certificates" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "nginx_template_folder_idx" ON "nginx_templates" USING btree ("folder_id");