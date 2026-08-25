CREATE TABLE "docker_source_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"delivery_id" text NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"commit_sha" varchar(64),
	"accepted" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docker_source_webhook_deliveries" ADD CONSTRAINT "docker_source_webhook_deliveries_source_binding_id_docker_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."docker_source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_source_webhook_delivery_unique" ON "docker_source_webhook_deliveries" USING btree ("source_binding_id","delivery_id");--> statement-breakpoint
CREATE INDEX "docker_source_webhook_delivery_received_idx" ON "docker_source_webhook_deliveries" USING btree ("received_at");