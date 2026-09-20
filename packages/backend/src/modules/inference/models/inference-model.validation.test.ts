import { describe, expect, it } from 'vitest';
import { UpdateInferenceModelSchema } from '../inference.schemas.js';
import { normalizeSystemPrompt } from './inference-model.validation.js';

describe('inference model system prompt', () => {
  it('clears blank prompts and trims configured ones', () => {
    expect(normalizeSystemPrompt(undefined)).toBeNull();
    expect(normalizeSystemPrompt(null)).toBeNull();
    expect(normalizeSystemPrompt('  \n ')).toBeNull();
    expect(normalizeSystemPrompt('  Be terse.\n')).toBe('Be terse.');
  });

  it('accepts only the append and replace delivery modes', () => {
    expect(UpdateInferenceModelSchema.safeParse({ systemPrompt: 'x', systemPromptMode: 'replace' }).success).toBe(true);
    expect(UpdateInferenceModelSchema.safeParse({ systemPrompt: null }).success).toBe(true);
    expect(UpdateInferenceModelSchema.safeParse({ systemPromptMode: 'prepend' }).success).toBe(false);
    expect(UpdateInferenceModelSchema.safeParse({ systemPrompt: 'x'.repeat(32_001) }).success).toBe(false);
  });
});
