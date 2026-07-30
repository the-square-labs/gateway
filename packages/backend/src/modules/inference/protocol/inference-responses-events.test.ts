import { describe, expect, it } from 'vitest';
import { parseResponsesRequest } from './inference-parse.js';
import { InferenceResponseCollector } from './inference-response.js';
import { ResponsesEventEncoder } from './inference-responses-events.js';

describe('ResponsesEventEncoder', () => {
  it('refuses to fabricate completion without a terminal event', () => {
    const request = parseResponsesRequest({ model: 'model', input: 'Hello', stream: true });
    const collector = new InferenceResponseCollector(request, 'resp_1', 'model');
    collector.consume({ type: 'output_text.delta', itemId: 'msg_1', delta: 'Partial' });

    expect(new ResponsesEventEncoder('resp_1', 'model').complete(collector.result())).toEqual([
      expect.objectContaining({
        type: 'error',
        status: 502,
        error: expect.objectContaining({ code: 'upstream_stream_incomplete' }),
      }),
    ]);
  });

  it('emits the explicit incomplete terminal and its reason', () => {
    const request = parseResponsesRequest({ model: 'model', input: 'Hello', stream: true });
    const collector = new InferenceResponseCollector(request, 'resp_1', 'model');
    collector.consume({
      type: 'completed',
      status: 'incomplete',
      finishReason: 'max_output_tokens',
      incompleteReason: 'max_output_tokens',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    expect(new ResponsesEventEncoder('resp_1', 'model').complete(collector.result())).toEqual([
      expect.objectContaining({
        type: 'response.incomplete',
        response: expect.objectContaining({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      }),
    ]);
  });

  it('keeps annotated refusal and hosted output items in the Responses lifecycle', () => {
    const encoder = new ResponsesEventEncoder('resp_1', 'model');
    const message = {
      type: 'message' as const,
      id: 'msg_1',
      role: 'assistant' as const,
      text: 'Source',
      refusal: 'Cannot continue',
      annotations: [{ type: 'url_citation', url: 'https://example.com' }],
    };
    const hosted = {
      type: 'hosted' as const,
      id: 'ws_1',
      raw: { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    };

    const messages = [
      ...encoder.event({ type: 'item.done', item: message }),
      ...encoder.event({ type: 'item.done', item: hosted }),
    ];
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'response.refusal.done', refusal: 'Cannot continue' }),
        expect.objectContaining({
          type: 'response.output_item.done',
          item: expect.objectContaining({ type: 'web_search_call', id: 'ws_1' }),
        }),
      ])
    );
    const outputTextDone = messages.find(
      (event) => event.type === 'response.content_part.done' && event.content_index === 0
    );
    expect(outputTextDone).toMatchObject({
      part: { type: 'output_text', text: 'Source', annotations: [{ type: 'url_citation' }] },
    });
  });
});
