-- Managed storage links record whether the workload's runtime already carries the link (`active`) or the link is
-- saved in the workload's desired configuration and takes effect when the workload is next created, started or
-- rolled out (`target_applied`). Links created before this column were applied synchronously, so they are active.
ALTER TABLE "managed_storage_bindings" ADD COLUMN IF NOT EXISTS "observed_state" varchar(32) DEFAULT 'active' NOT NULL;
