ALTER TABLE "external_ssh_connectors" ADD COLUMN "test_status" varchar(32) DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_ssh_connectors" ADD COLUMN "test_last_error" text;--> statement-breakpoint
ALTER TABLE "external_ssh_connectors" ADD COLUMN "tested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "external_ssh_connector_health_idx" ON "external_ssh_connectors" USING btree ("enabled","tested_at");
