DROP VIEW IF EXISTS "public"."gateway_relay_bindings_v1";--> statement-breakpoint
DROP VIEW IF EXISTS "public"."gateway_relay_managed_databases_v1";--> statement-breakpoint
DROP VIEW IF EXISTS "public"."gateway_relay_node_identities_v1";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_relay') THEN
		EXECUTE 'DROP OWNED BY gateway_relay';
		EXECUTE 'DROP ROLE gateway_relay';
	END IF;
END
$$;--> statement-breakpoint
CREATE TYPE "public"."relay_signing_key_status" AS ENUM('pending', 'active', 'verification_only', 'retired');--> statement-breakpoint
CREATE TABLE "relay_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"owner_kind" varchar(64) NOT NULL,
	"owner_id" uuid NOT NULL,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" uuid NOT NULL,
	"certificate_sha256" varchar(71) NOT NULL,
	"max_concurrent_sessions" integer DEFAULT 256 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_endpoints_owner_unique" UNIQUE("owner_kind","owner_id")
);
--> statement-breakpoint
CREATE TABLE "relay_grant_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" varchar(64) NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text,
	"encrypted_dek" text,
	"status" "relay_signing_key_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"verify_until" timestamp with time zone,
	"private_key_destroyed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "relay_grant_signing_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "relay_policy_state" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"gateway_instance_id" uuid NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"owner_kind" varchar(64) NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_id" uuid NOT NULL,
	"source_certificate_sha256" varchar(71) NOT NULL,
	"target_endpoint_id" uuid NOT NULL,
	"max_concurrent_sessions" integer DEFAULT 16 NOT NULL,
	"max_frame_bytes" integer DEFAULT 1048576 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_routes_owner_unique" UNIQUE("owner_kind","owner_id")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "certificate_fingerprint" varchar(71);--> statement-breakpoint
ALTER TABLE "relay_routes" ADD CONSTRAINT "relay_routes_target_endpoint_id_relay_endpoints_id_fk" FOREIGN KEY ("target_endpoint_id") REFERENCES "public"."relay_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_endpoints_subject_idx" ON "relay_endpoints" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "relay_grant_signing_keys_status_idx" ON "relay_grant_signing_keys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "relay_routes_source_idx" ON "relay_routes" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "relay_routes_target_idx" ON "relay_routes" USING btree ("target_endpoint_id");
