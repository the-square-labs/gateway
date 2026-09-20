ALTER TABLE "inference_models" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "inference_models" ADD COLUMN "system_prompt_mode" varchar(16) DEFAULT 'append' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_system_prompt_mode_valid" CHECK ("inference_models"."system_prompt_mode" IN ('append', 'replace'));