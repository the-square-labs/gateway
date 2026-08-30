ALTER TABLE "page_projects" ADD COLUMN "spa_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "fallback_url" text;