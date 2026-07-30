CREATE TABLE "inference_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" varchar(20) NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_limit_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_type" varchar(16) NOT NULL,
	"user_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"credits_5h" numeric(24, 6) NOT NULL,
	"credits_7d" numeric(24, 6) NOT NULL,
	"credits_30d" numeric(24, 6) NOT NULL,
	"api_monthly_microdollars" bigint NOT NULL,
	"billing_timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_limit_subject_valid" CHECK (("inference_limit_policies"."policy_type" = 'default' AND "inference_limit_policies"."user_id" IS NULL) OR ("inference_limit_policies"."policy_type" = 'user' AND "inference_limit_policies"."user_id" IS NOT NULL)),
	CONSTRAINT "inference_limit_values_nonnegative" CHECK ("inference_limit_policies"."credits_5h" >= 0 AND "inference_limit_policies"."credits_7d" >= 0 AND "inference_limit_policies"."credits_30d" >= 0 AND "inference_limit_policies"."api_monthly_microdollars" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_model_access_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"group_id" uuid,
	"user_id" uuid,
	"effect" varchar(8) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_model_access_subject_valid" CHECK (("inference_model_access_rules"."subject_type" = 'group' AND "inference_model_access_rules"."group_id" IS NOT NULL AND "inference_model_access_rules"."user_id" IS NULL) OR ("inference_model_access_rules"."subject_type" = 'user' AND "inference_model_access_rules"."user_id" IS NOT NULL AND "inference_model_access_rules"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inference_model_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"discovered_model_id" uuid,
	"upstream_model_id" text NOT NULL,
	"source_type" varchar(16) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"subscription_multiplier_override" numeric(20, 6),
	"reasoning_effort_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities_override" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_model_sources_multiplier_positive" CHECK ("inference_model_sources"."subscription_multiplier_override" IS NULL OR "inference_model_sources"."subscription_multiplier_override" > 0)
);
--> statement-breakpoint
CREATE TABLE "inference_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"context_window" integer NOT NULL,
	"max_input_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"auto_compact_token_limit" integer NOT NULL,
	"modalities" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasoning_efforts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_reasoning_effort" varchar(32),
	"default_access_allowed" boolean DEFAULT false NOT NULL,
	"subscription_multiplier" numeric(20, 6) DEFAULT '1' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_models_context_positive" CHECK ("inference_models"."context_window" > 0),
	CONSTRAINT "inference_models_token_limits_valid" CHECK ("inference_models"."max_input_tokens" > 0 AND "inference_models"."max_output_tokens" > 0 AND "inference_models"."auto_compact_token_limit" > 0 AND "inference_models"."auto_compact_token_limit" <= "inference_models"."max_input_tokens"),
	CONSTRAINT "inference_models_multiplier_positive" CHECK ("inference_models"."subscription_multiplier" > 0)
);
--> statement-breakpoint
CREATE TABLE "inference_pricing_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"version" varchar(80) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"input_microdollars_per_million" bigint,
	"cached_input_microdollars_per_million" bigint,
	"cache_write_microdollars_per_million" bigint,
	"output_microdollars_per_million" bigint,
	"reasoning_microdollars_per_million" bigint,
	"other_unit_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" varchar(16) NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_discovered_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"remote_model_id" text NOT NULL,
	"display_name" text,
	"context_window" integer,
	"max_input_tokens" integer,
	"max_output_tokens" integer,
	"auto_compact_token_limit" integer,
	"modalities" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasoning_efforts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar(80) NOT NULL,
	"name" varchar(255) NOT NULL,
	"auth_type" varchar(16) NOT NULL,
	"base_url" text NOT NULL,
	"account_external_id" text,
	"account_label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"routing_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"health_reason" text,
	"sync_status" varchar(16) DEFAULT 'never' NOT NULL,
	"sync_last_error" text,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_provider_credentials" (
	"connection_id" uuid NOT NULL,
	"credential_kind" varchar(32) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"secret_last4" varchar(16),
	"expires_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_provider_credentials_connection_id_credential_kind_pk" PRIMARY KEY("connection_id","credential_kind")
);
--> statement-breakpoint
CREATE TABLE "inference_provider_settings" (
	"provider_id" varchar(80) PRIMARY KEY NOT NULL,
	"routing_strategy" varchar(16) DEFAULT 'balanced' NOT NULL,
	"terms_accepted_version" varchar(80),
	"terms_accepted_at" timestamp with time zone,
	"terms_accepted_by" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_quota_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"dimension" varchar(128) NOT NULL,
	"model_bucket" varchar(255),
	"status" varchar(16) NOT NULL,
	"remaining_fraction" numeric(12, 9),
	"remaining_value" numeric(30, 9),
	"limit_value" numeric(30, 9),
	"reset_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_quota_fraction_range" CHECK ("inference_quota_snapshots"."remaining_fraction" IS NULL OR ("inference_quota_snapshots"."remaining_fraction" >= 0 AND "inference_quota_snapshots"."remaining_fraction" <= 1))
);
--> statement-breakpoint
CREATE TABLE "inference_request_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"source_id" uuid,
	"connection_id" uuid,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"upstream_status" integer,
	"error_code" varchar(128),
	"emitted_output" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"uncached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inference_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"token_id" uuid,
	"model_id" uuid,
	"source_id" uuid,
	"connection_id" uuid,
	"pricing_snapshot_id" uuid,
	"idempotency_key_hash" text,
	"affinity_key_hash" text,
	"protocol" varchar(32) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"public_model_id" text NOT NULL,
	"upstream_model_id" text,
	"budget_type" varchar(16),
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"is_compaction" boolean DEFAULT false NOT NULL,
	"estimated_usage" boolean DEFAULT false NOT NULL,
	"price_version" varchar(80),
	"model_multiplier" numeric(20, 6),
	"burn_multiplier" numeric(20, 6),
	"credits_charged" numeric(24, 6) DEFAULT '0' NOT NULL,
	"api_microdollars_charged" bigint DEFAULT 0 NOT NULL,
	"uncached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"response_status" integer,
	"error_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_requests_charges_nonnegative" CHECK ("inference_requests"."credits_charged" >= 0 AND "inference_requests"."api_microdollars_charged" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid,
	"entry_type" varchar(16) NOT NULL,
	"budget_type" varchar(16) NOT NULL,
	"credits" numeric(24, 6) DEFAULT '0' NOT NULL,
	"api_microdollars" bigint DEFAULT 0 NOT NULL,
	"uncached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"reason" varchar(128),
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "inference_usage_ledger_values_nonnegative" CHECK ("inference_usage_ledger"."credits" >= 0 AND "inference_usage_ledger"."api_microdollars" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD CONSTRAINT "inference_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_limit_policies" ADD CONSTRAINT "inference_limit_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_limit_policies" ADD CONSTRAINT "inference_limit_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_access_rules" ADD CONSTRAINT "inference_model_access_rules_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_access_rules" ADD CONSTRAINT "inference_model_access_rules_group_id_permission_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."permission_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_access_rules" ADD CONSTRAINT "inference_model_access_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_access_rules" ADD CONSTRAINT "inference_model_access_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_sources" ADD CONSTRAINT "inference_model_sources_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_sources" ADD CONSTRAINT "inference_model_sources_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_model_sources" ADD CONSTRAINT "inference_model_sources_discovered_model_id_inference_discovered_models_id_fk" FOREIGN KEY ("discovered_model_id") REFERENCES "public"."inference_discovered_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_pricing_snapshots" ADD CONSTRAINT "inference_pricing_snapshots_source_id_inference_model_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inference_model_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_pricing_snapshots" ADD CONSTRAINT "inference_pricing_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_discovered_models" ADD CONSTRAINT "inference_discovered_models_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_credentials" ADD CONSTRAINT "inference_provider_credentials_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_provider_settings" ADD CONSTRAINT "inference_provider_settings_terms_accepted_by_users_id_fk" FOREIGN KEY ("terms_accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_quota_snapshots" ADD CONSTRAINT "inference_quota_snapshots_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD CONSTRAINT "inference_request_attempts_request_id_inference_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."inference_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD CONSTRAINT "inference_request_attempts_source_id_inference_model_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inference_model_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD CONSTRAINT "inference_request_attempts_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_token_id_inference_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."inference_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_model_id_inference_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."inference_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_source_id_inference_model_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inference_model_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_connection_id_inference_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."inference_provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_pricing_snapshot_id_inference_pricing_snapshots_id_fk" FOREIGN KEY ("pricing_snapshot_id") REFERENCES "public"."inference_pricing_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_ledger" ADD CONSTRAINT "inference_usage_ledger_request_id_inference_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."inference_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_ledger" ADD CONSTRAINT "inference_usage_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage_ledger" ADD CONSTRAINT "inference_usage_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_tokens_token_hash_unique" ON "inference_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "inference_tokens_user_idx" ON "inference_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "inference_tokens_active_idx" ON "inference_tokens" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_limit_default_unique" ON "inference_limit_policies" USING btree ("policy_type") WHERE "inference_limit_policies"."policy_type" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX "inference_limit_user_unique" ON "inference_limit_policies" USING btree ("user_id") WHERE "inference_limit_policies"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_model_access_group_unique" ON "inference_model_access_rules" USING btree ("model_id","group_id") WHERE "inference_model_access_rules"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_model_access_user_unique" ON "inference_model_access_rules" USING btree ("model_id","user_id") WHERE "inference_model_access_rules"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inference_model_access_model_idx" ON "inference_model_access_rules" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_model_sources_model_connection_remote_unique" ON "inference_model_sources" USING btree ("model_id","connection_id","upstream_model_id");--> statement-breakpoint
CREATE INDEX "inference_model_sources_route_idx" ON "inference_model_sources" USING btree ("model_id","enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_models_public_id_unique" ON "inference_models" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "inference_models_enabled_idx" ON "inference_models" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_pricing_source_version_unique" ON "inference_pricing_snapshots" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "inference_pricing_source_effective_idx" ON "inference_pricing_snapshots" USING btree ("source_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_discovered_models_connection_remote_unique" ON "inference_discovered_models" USING btree ("connection_id","remote_model_id");--> statement-breakpoint
CREATE INDEX "inference_discovered_models_connection_idx" ON "inference_discovered_models" USING btree ("connection_id","available");--> statement-breakpoint
CREATE INDEX "inference_provider_connections_provider_idx" ON "inference_provider_connections" USING btree ("provider_id","enabled","deleted_at");--> statement-breakpoint
CREATE INDEX "inference_provider_connections_routing_idx" ON "inference_provider_connections" USING btree ("provider_id","routing_order");--> statement-breakpoint
CREATE INDEX "inference_provider_connections_sync_idx" ON "inference_provider_connections" USING btree ("sync_status","next_sync_at");--> statement-breakpoint
CREATE INDEX "inference_quota_connection_time_idx" ON "inference_quota_snapshots" USING btree ("connection_id","fetched_at");--> statement-breakpoint
CREATE INDEX "inference_quota_validity_idx" ON "inference_quota_snapshots" USING btree ("status","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_attempts_request_sequence_unique" ON "inference_request_attempts" USING btree ("request_id","sequence");--> statement-breakpoint
CREATE INDEX "inference_attempts_connection_started_idx" ON "inference_request_attempts" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_requests_user_idempotency_unique" ON "inference_requests" USING btree ("user_id","idempotency_key_hash") WHERE "inference_requests"."idempotency_key_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inference_requests_user_created_idx" ON "inference_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "inference_requests_status_idx" ON "inference_requests" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "inference_requests_model_created_idx" ON "inference_requests" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "inference_usage_ledger_user_time_idx" ON "inference_usage_ledger" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inference_usage_ledger_request_idx" ON "inference_usage_ledger" USING btree ("request_id");--> statement-breakpoint
CREATE FUNCTION "gateway_reject_inference_usage_ledger_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'inference_usage_ledger is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "inference_usage_ledger_immutable"
BEFORE UPDATE OR DELETE ON "inference_usage_ledger"
FOR EACH ROW EXECUTE FUNCTION "gateway_reject_inference_usage_ledger_mutation"();
