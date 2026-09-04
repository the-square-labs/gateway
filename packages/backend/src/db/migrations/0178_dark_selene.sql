DROP INDEX "docker_build_artifacts_build_unique";--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ALTER COLUMN "build_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ALTER COLUMN "source_binding_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD COLUMN "owner_kind" varchar(32) DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD COLUMN "owner_key" text;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD COLUMN "source_image_reference" text;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_artifacts_availability_unique" ON "docker_build_artifacts" USING btree ("owner_kind","owner_key","registry_repository") WHERE "docker_build_artifacts"."owner_kind" = 'availability';--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_artifacts_build_unique" ON "docker_build_artifacts" USING btree ("build_id") WHERE "docker_build_artifacts"."build_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD CONSTRAINT "docker_build_artifacts_owner_check" CHECK ((
        "docker_build_artifacts"."owner_kind" = 'build'
        AND "docker_build_artifacts"."build_id" IS NOT NULL
        AND "docker_build_artifacts"."source_binding_id" IS NOT NULL
        AND "docker_build_artifacts"."owner_key" IS NULL
        AND "docker_build_artifacts"."source_image_reference" IS NULL
      ) OR (
        "docker_build_artifacts"."owner_kind" = 'availability'
        AND "docker_build_artifacts"."build_id" IS NULL
        AND "docker_build_artifacts"."source_binding_id" IS NULL
        AND "docker_build_artifacts"."owner_key" IS NOT NULL
        AND "docker_build_artifacts"."source_image_reference" IS NOT NULL
      ));