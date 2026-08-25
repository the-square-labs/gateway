ALTER TABLE "docker_compose_revisions" ADD COLUMN "source_yaml" text;--> statement-breakpoint
UPDATE "docker_compose_revisions" SET "source_yaml" = "original_yaml" WHERE "source_yaml" IS NULL;--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ALTER COLUMN "source_yaml" SET NOT NULL;
