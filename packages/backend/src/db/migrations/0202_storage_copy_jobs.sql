CREATE TABLE "storage_copy_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_connection_id" uuid,
	"source_connection_name" text NOT NULL,
	"destination_connection_id" uuid,
	"destination_connection_name" text NOT NULL,
	"buckets" jsonb,
	"mode" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"create_buckets" boolean DEFAULT false NOT NULL,
	"allow_live_destination" boolean DEFAULT false NOT NULL,
	"executor_node_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"limits" jsonb NOT NULL,
	"progress" jsonb,
	"report" jsonb,
	"sanitized_error" text,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"runtime_cleanup_pending" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_copy_jobs" ADD CONSTRAINT "storage_copy_jobs_source_connection_id_object_storage_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."object_storage_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_copy_jobs" ADD CONSTRAINT "storage_copy_jobs_destination_connection_id_object_storage_connections_id_fk" FOREIGN KEY ("destination_connection_id") REFERENCES "public"."object_storage_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_copy_jobs" ADD CONSTRAINT "storage_copy_jobs_executor_node_id_nodes_id_fk" FOREIGN KEY ("executor_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_copy_jobs" ADD CONSTRAINT "storage_copy_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_copy_jobs_status_idx" ON "storage_copy_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "storage_copy_jobs_source_idx" ON "storage_copy_jobs" USING btree ("source_connection_id");--> statement-breakpoint
CREATE INDEX "storage_copy_jobs_destination_idx" ON "storage_copy_jobs" USING btree ("destination_connection_id");--> statement-breakpoint
CREATE INDEX "storage_copy_jobs_executor_idx" ON "storage_copy_jobs" USING btree ("executor_node_id");--> statement-breakpoint
CREATE INDEX "storage_copy_jobs_created_at_idx" ON "storage_copy_jobs" USING btree ("created_at");
