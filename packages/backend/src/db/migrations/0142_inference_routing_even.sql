-- The pre-existing `balanced` value meant equal distribution. Preserve that
-- behavior on upgrade before `balanced` becomes quota-weighted.
UPDATE "inference_provider_settings"
SET "routing_strategy" = 'even', "updated_at" = now()
WHERE "routing_strategy" = 'balanced';
