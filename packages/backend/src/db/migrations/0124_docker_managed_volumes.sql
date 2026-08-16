CREATE TABLE "docker_managed_volumes" (
	"node_id" uuid NOT NULL,
	"volume_name" text NOT NULL,
	"origin" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_managed_volumes_pkey" PRIMARY KEY("node_id","volume_name")
);
--> statement-breakpoint
ALTER TABLE "docker_managed_volumes" ADD CONSTRAINT "docker_managed_volumes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_managed_volumes" ADD CONSTRAINT "docker_managed_volumes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_managed_volumes_created_by_idx" ON "docker_managed_volumes" USING btree ("created_by_id");