ALTER TABLE "hosting_resources" DROP CONSTRAINT "hosting_resource_identity_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_resource_active_identity_unique" ON "hosting_resources" USING btree ("provider","authority","kind","remote_id") WHERE "hosting_resources"."missing_since" is null;
--> statement-breakpoint
UPDATE "integration_connectors"
SET "settings" = jsonb_set("settings", '{proxmoxAllocationAuthority}', to_jsonb("settings"->>'authority'), true)
WHERE "provider" = 'proxmox'
  AND "settings"->>'kind' = 'hosting'
  AND "settings"->>'proxmoxAllocationAuthority' IS NULL
  AND "settings"->>'authority' ~ '^proxmox:ca:[a-f0-9]{64}$';
