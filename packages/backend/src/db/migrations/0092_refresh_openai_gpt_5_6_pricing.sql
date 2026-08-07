INSERT INTO "inference_pricing_snapshots" (
  "source_id",
  "version",
  "currency",
  "input_microdollars_per_million",
  "cached_input_microdollars_per_million",
  "cache_write_microdollars_per_million",
  "output_microdollars_per_million",
  "other_unit_prices",
  "source"
)
SELECT
  "sources"."id",
  'openai-api-2026-08-06',
  'USD',
  CASE "normalized"."model_id"
    WHEN 'gpt-5.6' THEN 5000000
    WHEN 'gpt-5.6-sol' THEN 5000000
    WHEN 'gpt-5.6-terra' THEN 2000000
    WHEN 'gpt-5.6-luna' THEN 200000
  END,
  CASE "normalized"."model_id"
    WHEN 'gpt-5.6' THEN 500000
    WHEN 'gpt-5.6-sol' THEN 500000
    WHEN 'gpt-5.6-terra' THEN 200000
    WHEN 'gpt-5.6-luna' THEN 20000
  END,
  CASE "normalized"."model_id"
    WHEN 'gpt-5.6' THEN 6250000
    WHEN 'gpt-5.6-sol' THEN 6250000
    WHEN 'gpt-5.6-terra' THEN 2500000
    WHEN 'gpt-5.6-luna' THEN 250000
  END,
  CASE "normalized"."model_id"
    WHEN 'gpt-5.6' THEN 30000000
    WHEN 'gpt-5.6-sol' THEN 30000000
    WHEN 'gpt-5.6-terra' THEN 12000000
    WHEN 'gpt-5.6-luna' THEN 1200000
  END,
  jsonb_build_object(
    'long_context_threshold_tokens', 272000,
    'long_context_input_microdollars_per_million',
      CASE "normalized"."model_id"
        WHEN 'gpt-5.6' THEN 10000000
        WHEN 'gpt-5.6-sol' THEN 10000000
        WHEN 'gpt-5.6-terra' THEN 4000000
        WHEN 'gpt-5.6-luna' THEN 400000
      END,
    'long_context_cached_input_microdollars_per_million',
      CASE "normalized"."model_id"
        WHEN 'gpt-5.6' THEN 1000000
        WHEN 'gpt-5.6-sol' THEN 1000000
        WHEN 'gpt-5.6-terra' THEN 400000
        WHEN 'gpt-5.6-luna' THEN 40000
      END,
    'long_context_cache_write_microdollars_per_million',
      CASE "normalized"."model_id"
        WHEN 'gpt-5.6' THEN 12500000
        WHEN 'gpt-5.6-sol' THEN 12500000
        WHEN 'gpt-5.6-terra' THEN 5000000
        WHEN 'gpt-5.6-luna' THEN 500000
      END,
    'long_context_output_microdollars_per_million',
      CASE "normalized"."model_id"
        WHEN 'gpt-5.6' THEN 45000000
        WHEN 'gpt-5.6-sol' THEN 45000000
        WHEN 'gpt-5.6-terra' THEN 18000000
        WHEN 'gpt-5.6-luna' THEN 1800000
      END
  ),
  'provider'
FROM "inference_model_sources" AS "sources"
JOIN "inference_provider_connections" AS "connections"
  ON "connections"."id" = "sources"."connection_id"
CROSS JOIN LATERAL (
  SELECT regexp_replace(lower("sources"."upstream_model_id"), '-[0-9]{4}(-[0-9]{2}){2}$', '') AS "model_id"
) AS "normalized"
WHERE "sources"."source_type" = 'api'
  AND "connections"."provider_id" = 'openai-apikey'
  AND "normalized"."model_id" IN ('gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
  AND NOT EXISTS (
    SELECT 1
    FROM "inference_pricing_snapshots" AS "snapshots"
    WHERE "snapshots"."source_id" = "sources"."id"
      AND "snapshots"."source" = 'manual'
  )
ON CONFLICT ("source_id", "version") DO NOTHING;
