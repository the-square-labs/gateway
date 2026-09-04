ALTER TABLE "docker_availability_policies" ADD COLUMN "origin_node_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "spec_fingerprint" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "portable_spec" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "image_reference" text;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "compose_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN "should_run" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_origin_node_id_nodes_id_fk" FOREIGN KEY ("origin_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_compose_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("compose_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "docker_availability_policies" p
SET
  "origin_node_id" = d."node_id",
  "display_name" = d."name",
  "spec_fingerprint" = md5(d."desired_config"::text || d."health_config"::text || d."active_slot"),
  "portable_spec" = jsonb_build_object(
    'desiredConfig', d."desired_config",
    'healthConfig', d."health_config",
    'routerImage', d."router_image",
    'activeSlot', d."active_slot"
  ),
  "image_reference" = d."desired_config"->>'image',
  "should_run" = d."status" <> 'stopped'
FROM "docker_deployments" d
WHERE p."resource_kind" = 'deployment' AND p."deployment_id" = d."id";--> statement-breakpoint
UPDATE "docker_availability_policies" p
SET
  "origin_node_id" = c."node_id",
  "display_name" = c."name",
  "spec_fingerprint" = COALESCE(r."config_digest", md5(c."id"::text)),
  "portable_spec" = jsonb_build_object(
    'revisionId', r."id",
    'configDigest', r."config_digest"
  ),
  "compose_revision_id" = r."id",
  "should_run" = c."desired_state" = 'running'
FROM "docker_compose_projects" c
LEFT JOIN "docker_compose_revisions" r ON r."id" = c."active_revision_id"
WHERE p."resource_kind" = 'compose' AND p."compose_project_id" = c."id";
