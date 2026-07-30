const CODEX_BASE_INSTRUCTIONS = `You are Codex, a coding agent working with the user in their workspace.
Use the provided tools to inspect and modify the workspace when the task requires it. Keep tool calls and reasoning separate from user-visible answers, preserve existing user work, and continue until the requested outcome is handled.`;

const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'No additional reasoning',
  minimal: 'Minimal reasoning for straightforward tasks',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced speed and reasoning depth',
  high: 'Greater reasoning depth for complex tasks',
  xhigh: 'Extra high reasoning depth for complex tasks',
  max: 'Maximum provider reasoning depth',
  ultra: 'Maximum reasoning for the hardest tasks',
};

export interface PublicInferenceModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  display_name: string;
  context_window: number;
  max_input_tokens: number;
  max_output_tokens?: number;
  auto_compact_token_limit: number;
  input_modalities: string[];
  capabilities: Record<string, boolean>;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string | null;
  supported_service_tiers?: string[];
}

export function codexModelsResponse(models: PublicInferenceModel[]) {
  return {
    models: models.map((model, index) => {
      const supported = model.supported_reasoning_efforts.filter((effort) => CODEX_EFFORTS.has(effort));
      const defaultEffort =
        model.default_reasoning_effort && supported.includes(model.default_reasoning_effort)
          ? model.default_reasoning_effort
          : supported[0];
      const reasoning = model.capabilities.reasoning === true && supported.length > 0;
      const fast = model.supported_service_tiers?.includes('priority') === true;
      return {
        slug: model.id,
        display_name: model.display_name,
        description: `Gateway inference model ${model.display_name}`,
        default_reasoning_level: reasoning ? defaultEffort : null,
        supported_reasoning_levels: reasoning
          ? supported.map((effort) => ({ effort, description: EFFORT_DESCRIPTIONS[effort] ?? effort }))
          : [],
        shell_type: model.capabilities.tools === false ? 'disabled' : 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: index,
        additional_speed_tiers: fast ? ['fast'] : [],
        service_tiers: fast
          ? [{ id: 'priority', name: 'Fast', description: '1.5x speed, 2x Gateway credit usage' }]
          : [],
        default_service_tier: null,
        availability_nux: null,
        upgrade: null,
        base_instructions: CODEX_BASE_INSTRUCTIONS,
        model_messages: null,
        include_skills_usage_instructions: false,
        supports_reasoning_summary_parameter: reasoning,
        default_reasoning_summary: reasoning ? 'auto' : 'none',
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: model.capabilities.tools === false ? null : 'freeform',
        web_search_tool_type: 'text',
        truncation_policy: { mode: 'tokens', limit: model.auto_compact_token_limit },
        supports_parallel_tool_calls: model.capabilities.tools !== false,
        supports_image_detail_original: model.input_modalities.includes('image'),
        context_window: model.context_window,
        max_context_window: model.context_window,
        auto_compact_token_limit: model.auto_compact_token_limit,
        comp_hash: null,
        effective_context_window_percent: Math.max(
          1,
          Math.min(100, Math.floor((model.max_input_tokens / model.context_window) * 100))
        ),
        experimental_supported_tools: [],
        input_modalities: model.input_modalities.filter((value) => ['audio', 'image', 'text'].includes(value)),
        supports_search_tool: model.capabilities.search === true,
        use_responses_lite: false,
        auto_review_model_override: null,
        tool_mode: null,
        multi_agent_version: null,
      };
    }),
  };
}
