-- Availability data-plane lease. Policies get a partition mode (strict by default, so no existing policy changes
-- behaviour), an optional lease witness, and a lease state that starts in legacy: the backend keeps reacting to node
-- loss until every candidate and ingress node advertises availability_lease_v1. Each policy carries its own voters
-- (candidate hosts plus witnesses) and voter epoch; the cluster row only tracks the manifest signing key. Members hold
-- what each daemon and relay last reported, and observations record the lease holder of every (policy, slot).
-- Standby Secure Link members are marked dormant; existing members stay active.
CREATE TABLE "availability_lease_cluster" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"signing_key_id" varchar(64),
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_lease_key_rotations" (
	"key_id" varchar(64) PRIMARY KEY NOT NULL,
	"previous_key_id" varchar(64) NOT NULL,
	"public_key" text NOT NULL,
	"public_key_fingerprint" varchar(71) NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_lease_members" (
	"member_id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"node_id" uuid,
	"relay_instance_id" uuid,
	"identity_public_key" text,
	"watchdog_ready" boolean DEFAULT false NOT NULL,
	"incarnation" bigint DEFAULT 0 NOT NULL,
	"epoch_ack" bigint DEFAULT 0 NOT NULL,
	"trusted_key_ids" text[] DEFAULT '{}' NOT NULL,
	"manifest_acks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lease_revision" bigint DEFAULT 0 NOT NULL,
	"abstaining" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_lease_members_kind_check" CHECK ("availability_lease_members"."kind" IN ('docker', 'nginx', 'relay'))
);
--> statement-breakpoint
CREATE TABLE "docker_availability_lease_observations" (
	"policy_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"holder_id" varchar(64),
	"placement_id" uuid,
	"ballot" jsonb,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"manifest_version" bigint DEFAULT 0 NOT NULL,
	"source" varchar(16) NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"holder_since" timestamp with time zone,
	"last_holder_id" varchar(64),
	"claimants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_availability_lease_observations_policy_id_slot_pk" PRIMARY KEY("policy_id","slot"),
	CONSTRAINT "docker_availability_lease_observations_slot_check" CHECK ("docker_availability_lease_observations"."slot" BETWEEN 0 AND 31),
	CONSTRAINT "docker_availability_lease_observations_source_check" CHECK ("docker_availability_lease_observations"."source" IN ('daemon', 'acceptor', 'relay'))
);
--> statement-breakpoint
CREATE TABLE "docker_availability_lease_state" (
	"policy_id" uuid PRIMARY KEY NOT NULL,
	"mode" varchar(16) DEFAULT 'legacy' NOT NULL,
	"reason" jsonb,
	"manifest_version" bigint DEFAULT 0 NOT NULL,
	"voter_epoch" bigint DEFAULT 0 NOT NULL,
	"quorum_sets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"voter_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"joint_version" bigint DEFAULT 0 NOT NULL,
	"joint_acked_at" timestamp with time zone,
	"witnesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"witness_warning" varchar(64),
	"manifest_digest" text,
	"manifest_block" text,
	"bootstrap_id" bigint DEFAULT 0 NOT NULL,
	"bootstrap" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_partition_mode" varchar(16),
	"legacy_requested" boolean DEFAULT false NOT NULL,
	"surge_slots" integer DEFAULT 0 NOT NULL,
	"strict_requested_at" timestamp with time zone,
	"copies_stopped_at" timestamp with time zone,
	"closing_started_at" timestamp with time zone,
	"closing_acked_at" timestamp with time zone,
	"planned_handoffs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_availability_lease_state_mode_check" CHECK ("docker_availability_lease_state"."mode" IN ('legacy', 'bootstrapping', 'lease', 'closing')),
	CONSTRAINT "docker_availability_lease_state_surge_check" CHECK ("docker_availability_lease_state"."surge_slots" BETWEEN 0 AND 32),
	CONSTRAINT "docker_availability_lease_state_version_check" CHECK ("docker_availability_lease_state"."manifest_version" >= 0 AND "docker_availability_lease_state"."voter_epoch" >= 0 AND "docker_availability_lease_state"."bootstrap_id" >= 0)
);
--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "partition_mode" varchar(16) DEFAULT 'strict' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "witness" varchar(64);--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "dormant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_lease_members" ADD CONSTRAINT "availability_lease_members_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_lease_members" ADD CONSTRAINT "availability_lease_members_relay_instance_id_relay_instances_id_fk" FOREIGN KEY ("relay_instance_id") REFERENCES "public"."relay_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_observations" ADD CONSTRAINT "docker_availability_lease_observations_policy_id_docker_availability_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."docker_availability_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_observations" ADD CONSTRAINT "docker_availability_lease_observations_placement_id_docker_availability_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."docker_availability_placements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_state" ADD CONSTRAINT "docker_availability_lease_state_policy_id_docker_availability_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."docker_availability_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_lease_members_node_idx" ON "availability_lease_members" USING btree ("node_id");--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_partition_mode_check" CHECK ("docker_availability_policies"."partition_mode" IN ('strict', 'available'));--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_dormant_check" CHECK (NOT "proxy_additional_secure_links"."dormant" OR "proxy_additional_secure_links"."purpose" = 'availability_member');