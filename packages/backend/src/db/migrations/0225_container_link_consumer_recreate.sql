-- A container link records the generation its container consumer was last recreated for (one recreate per
-- generation at most).
ALTER TABLE "container_links" ADD COLUMN "consumer_recreated_generation" integer;