DROP INDEX "ai_plans_one_active_per_conversation_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plans_one_active_per_conversation_idx" ON "ai_plans" USING btree ("conversation_id") WHERE "ai_plans"."status" IN ('drafting', 'validating', 'awaiting_decision', 'executing', 'pause_requested', 'paused', 'verifying');--> statement-breakpoint
WITH primary_sources AS (
	SELECT
		s.id AS source_id,
		s.model_id,
		m.context_window AS stored_context_window,
		m.max_input_tokens AS stored_max_input_tokens,
		m.max_output_tokens AS stored_max_output_tokens,
		d.context_window,
		d.max_input_tokens,
		coalesce(d.max_output_tokens, m.max_output_tokens) AS max_output_tokens,
		d.auto_compact_token_limit,
		CASE
			WHEN s.discovered_model_id IS NOT NULL
				AND s.metadata->>'origin' = 'discovery'
				AND jsonb_typeof(s.metadata->'technical') = 'object'
				AND jsonb_typeof(s.metadata->'technical'->'contextWindow') = 'number'
				AND jsonb_typeof(s.metadata->'technical'->'maxInputTokens') = 'number'
				AND (
					NOT (s.metadata->'technical' ? 'maxOutputTokens')
					OR jsonb_typeof(s.metadata->'technical'->'maxOutputTokens') = 'number'
				)
				AND ((s.metadata->'technical')::jsonb - ARRAY['contextWindow', 'maxInputTokens', 'maxOutputTokens']::text[]) = '{}'::jsonb
			THEN
				(s.metadata->'technical'->>'contextWindow')::integer = m.context_window
				AND (s.metadata->'technical'->>'maxInputTokens')::integer = m.max_input_tokens
				AND (
					(s.metadata->'technical' ? 'maxOutputTokens' AND (s.metadata->'technical'->>'maxOutputTokens')::integer = m.max_output_tokens)
					OR (NOT (s.metadata->'technical' ? 'maxOutputTokens') AND m.max_output_tokens IS NULL)
				)
				AND m.updated_at <= m.created_at + interval '5 seconds'
				AND s.updated_at <= s.created_at + interval '5 seconds'
				AND d.available = true
				AND d.context_window IS NOT NULL
				AND d.max_input_tokens IS NOT NULL
				AND d.auto_compact_token_limit IS NOT NULL
			ELSE false
		END AS generated_legacy_override
	FROM inference_model_sources s
	JOIN inference_models m ON m.id = s.model_id
	LEFT JOIN inference_discovered_models d ON d.id = s.discovered_model_id
	WHERE s.enabled = true
		AND COALESCE(s.metadata#>>'{composition,role}', 'primary') = 'primary'
), eligible_models AS (
	SELECT model_id
	FROM primary_sources
	GROUP BY model_id
	HAVING bool_and(generated_legacy_override)
), effective_limits AS (
	SELECT
		p.model_id,
		min(p.context_window)::integer AS context_window,
		min(p.max_input_tokens)::integer AS max_input_tokens,
		min(p.max_output_tokens)::integer AS max_output_tokens,
		least(min(p.auto_compact_token_limit), min(p.max_input_tokens))::integer AS auto_compact_token_limit
	FROM primary_sources p
	JOIN eligible_models e ON e.model_id = p.model_id
	GROUP BY p.model_id
), cleared_sources AS (
	UPDATE inference_model_sources s
	SET metadata = s.metadata - 'technical', updated_at = now()
	FROM primary_sources p
	JOIN eligible_models e ON e.model_id = p.model_id
	WHERE s.id = p.source_id
	RETURNING s.model_id
)
UPDATE inference_models m
SET
	context_window = limits.context_window,
	max_input_tokens = limits.max_input_tokens,
	max_output_tokens = limits.max_output_tokens,
	auto_compact_token_limit = limits.auto_compact_token_limit,
	updated_at = now()
FROM effective_limits limits
WHERE m.id = limits.model_id;
