ALTER TABLE "docker_secrets" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "docker_secrets" AS "secret"
SET "managed" = true
FROM "managed_database_bindings" AS "binding"
WHERE "secret"."node_id" = "binding"."target_node_id"
	AND "secret"."container_name" = CASE
		WHEN "binding"."target_type" = 'deployment' THEN 'deployment:' || "binding"."target_resource_id"
		ELSE "binding"."target_resource_id"
	END
	AND EXISTS (
		SELECT 1
		FROM jsonb_each_text("binding"."environment") AS "entry"
		WHERE "entry"."value" = "secret"."key"
	);
