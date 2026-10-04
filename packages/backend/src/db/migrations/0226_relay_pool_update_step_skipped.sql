-- A Relay Pool update skips a member that is not connected; a later run updates it once it reconnects.
ALTER TYPE "public"."relay_pool_update_step_state" ADD VALUE 'skipped';