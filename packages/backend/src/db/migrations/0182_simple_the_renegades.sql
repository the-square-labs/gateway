CREATE TABLE "hosting_node_bindings" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"host_identity_id" uuid NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosting_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid,
	"resource_id" uuid,
	"node_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"encrypted_bootstrap" text,
	"bootstrap_expires_at" timestamp with time zone,
	"provider_operation" jsonb,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"dispatch_started_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"generation" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "hosting_operation_intent_unique" UNIQUE("connector_id","action","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "hosting_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid,
	"provider" text NOT NULL,
	"authority" text NOT NULL,
	"remote_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text DEFAULT 'discovered' NOT NULL,
	"managed_host_identity" uuid,
	"incarnation" text,
	"snapshot" jsonb NOT NULL,
	"adoption_reason" text,
	"observed_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosting_resource_identity_unique" UNIQUE("provider","authority","kind","remote_id"),
	CONSTRAINT "hosting_resource_host_unique" UNIQUE("managed_host_identity"),
	CONSTRAINT "hosting_resource_host_pair_unique" UNIQUE("id","managed_host_identity")
);
--> statement-breakpoint
ALTER TABLE "hosting_node_bindings" ADD CONSTRAINT "hosting_node_bindings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_node_bindings" ADD CONSTRAINT "hosting_binding_resource_host_fk" FOREIGN KEY ("resource_id","host_identity_id") REFERENCES "public"."hosting_resources"("id","managed_host_identity") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_operations" ADD CONSTRAINT "hosting_operations_connector_id_integration_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."integration_connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_operations" ADD CONSTRAINT "hosting_operations_resource_id_hosting_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."hosting_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_operations" ADD CONSTRAINT "hosting_operations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_operations" ADD CONSTRAINT "hosting_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_resources" ADD CONSTRAINT "hosting_resources_connector_id_integration_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."integration_connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosting_binding_resource_idx" ON "hosting_node_bindings" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_operation_resource_active_unique" ON "hosting_operations" USING btree ("resource_id") WHERE "hosting_operations"."phase" NOT IN ('ready', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_operation_request_active_unique" ON "hosting_operations" USING btree ("connector_id","action","request_hash") WHERE "hosting_operations"."phase" NOT IN ('ready', 'failed');--> statement-breakpoint
CREATE INDEX "hosting_operation_due_idx" ON "hosting_operations" USING btree ("phase","next_poll_at");--> statement-breakpoint
CREATE INDEX "hosting_operation_actor_idx" ON "hosting_operations" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "hosting_resource_connector_idx" ON "hosting_resources" USING btree ("connector_id");