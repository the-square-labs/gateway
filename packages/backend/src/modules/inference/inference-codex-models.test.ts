import { describe, expect, it } from 'vitest';
import { codexModelsResponse, type PublicInferenceModel } from './inference-codex-models.js';

const MODEL: PublicInferenceModel = {
  id: 'gpt-5.6-luna',
  object: 'model',
  created: 1,
  owned_by: 'gateway',
  display_name: 'GPT-5.6 Luna',
  context_window: 1_050_000,
  max_input_tokens: 922_000,
  max_output_tokens: 128_000,
  auto_compact_token_limit: 829_800,
  input_modalities: ['text', 'image'],
  capabilities: { reasoning: true, tools: true, vision: true },
  supported_reasoning_efforts: ['low', 'high'],
  default_reasoning_effort: 'high',
};

describe('Codex model catalog service tiers', () => {
  it('advertises Fast with the Codex priority request value for eligible models', () => {
    const [model] = codexModelsResponse([{ ...MODEL, supported_service_tiers: ['priority'] }]).models;

    expect(model).toMatchObject({
      additional_speed_tiers: ['fast'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, 2x Gateway credit usage' }],
      default_service_tier: null,
    });
  });

  it('does not advertise Fast for ineligible models', () => {
    const [model] = codexModelsResponse([MODEL]).models;

    expect(model.additional_speed_tiers).toEqual([]);
    expect(model.service_tiers).toEqual([]);
  });

  it('advertises hosted web search without enabling the internal Responses Lite transport', () => {
    const [withoutSearch, withSearch] = codexModelsResponse([
      MODEL,
      { ...MODEL, id: 'search-model', capabilities: { ...MODEL.capabilities, search: true } },
    ]).models;

    expect(withoutSearch).toMatchObject({
      web_search_tool_type: 'text',
      supports_search_tool: false,
      use_responses_lite: false,
      shell_type: 'shell_command',
      apply_patch_tool_type: 'freeform',
      supports_parallel_tool_calls: true,
    });
    expect(withSearch).toMatchObject({
      web_search_tool_type: 'text',
      supports_search_tool: true,
      use_responses_lite: false,
    });
  });
});
