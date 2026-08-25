import { describe, expect, it } from 'vitest';
import {
  assertProviderInputWithinLimits,
  estimateProviderMessagesTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
} from './ai-token-estimator.js';

describe('AI token estimator', () => {
  it('accounts for array content, images, tool calls, and tool schemas', () => {
    const image = `data:image/png;base64,${Buffer.alloc(32_000).toString('base64')}`;
    const messages = [
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'inspect', arguments: '{"all":true}' } }],
      },
    ];
    const tools = [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }];

    expect(estimateProviderMessagesTokens(messages)).toBeGreaterThan(100);
    expect(estimateToolSchemaTokens(tools)).toBeGreaterThan(10);
  });

  it('uses a conservative estimate for code and tool-heavy context', () => {
    expect(estimateTextTokens('x'.repeat(1_116_000))).toBe(372_000);
  });

  it('fails explicitly instead of trimming a request over the hard input limit', () => {
    expect(() =>
      assertProviderInputWithinLimits([{ role: 'user', content: 'x'.repeat(10_000) }], [], {
        contextWindow: 2_000,
        maxInputTokens: 1_000,
        autoCompactTokenLimit: 900,
        outputReserveTokens: 100,
      })
    ).toThrowError(expect.objectContaining({ code: 'AI_CONTEXT_TOO_LARGE' }));
  });
});
