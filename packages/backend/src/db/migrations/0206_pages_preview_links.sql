-- Pages preview links: a stable random per-Project hash prefixes every Tag preview label
-- (`<hash>-<tag>.<Pages domain>`). It is never derived from the name; a rotation replaces it.
ALTER TABLE "page_projects" ADD COLUMN IF NOT EXISTS "preview_hash" varchar(12);
--> statement-breakpoint
-- Backfill 12 lowercase base32 characters per Project. Each character takes 5 bits of one byte of a fresh
-- gen_random_uuid() (bytes 0-5 and 10-15 carry no version or variant bits). The subquery references the outer row,
-- so PostgreSQL evaluates it once per Project instead of reusing one value for every row.
UPDATE "page_projects" AS "project"
SET "preview_hash" = (
  SELECT string_agg(
    substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(uuid_send(gen_random_uuid()), "bytes"."byte_index") % 32) + 1, 1),
    '' ORDER BY "bytes"."position"
  )
  FROM unnest(ARRAY[0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15]) WITH ORDINALITY AS "bytes"("byte_index", "position")
  WHERE "project"."id" IS NOT NULL
)
WHERE "project"."preview_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "page_projects" ALTER COLUMN "preview_hash" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_projects_preview_hash_unique" ON "page_projects" USING btree ("preview_hash");
--> statement-breakpoint
-- Optional Project access list applied to every preview host. Deleting a list that is still in use is refused.
ALTER TABLE "page_projects" ADD COLUMN IF NOT EXISTS "access_list_id" uuid;
--> statement-breakpoint
ALTER TABLE "page_projects" DROP CONSTRAINT IF EXISTS "page_projects_access_list_id_access_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_access_list_id_access_lists_id_fk" FOREIGN KEY ("access_list_id") REFERENCES "public"."access_lists"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_projects_access_list_idx" ON "page_projects" USING btree ("access_list_id");
--> statement-breakpoint
-- Tag preview hostnames. Existing Tags get one when next published; names that do not fit one DNS label together
-- with the hash keep none.
ALTER TABLE "page_tags" ADD COLUMN IF NOT EXISTS "preview_hostname" varchar(253);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_tags_preview_hostname_unique" ON "page_tags" USING btree ("preview_hostname");
--> statement-breakpoint
-- Optional Deployment expiry. Existing Deployments keep none and are never expired.
ALTER TABLE "page_deployments" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_deployments_expires_idx" ON "page_deployments" USING btree ("expires_at") WHERE "page_deployments"."expires_at" is not null;
--> statement-breakpoint
-- Declared upload format: `html` wraps a single HTML file as index.html; null detects the format from content.
ALTER TABLE "page_upload_sessions" ADD COLUMN IF NOT EXISTS "artifact_format" varchar(16);
