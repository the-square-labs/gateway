import { afterEach, describe, expect, it } from 'vitest';
import { InferenceUpstreamEmulator } from './inference-upstream.emulator.js';

const emulator = new InferenceUpstreamEmulator();

afterEach(async () => {
  await emulator.stop();
  emulator.reset();
});

describe('InferenceUpstreamEmulator', () => {
  it('serves model discovery, quota state, OAuth refresh, and extended operations', async () => {
    const baseUrl = await emulator.start();
    emulator.setQuotaRemaining(0.12);

    const models = (await fetch(`${baseUrl}/models`).then((response) => response.json())) as {
      data: Array<{ id: string }>;
    };
    const quota = (await fetch(`${baseUrl.replace(/\/v1$/, '')}/quota`).then((response) => response.json())) as {
      windows: Array<{ remaining_fraction: number }>;
    };
    const token = (await fetch(`${baseUrl.replace(/\/v1$/, '')}/oauth/token`, { method: 'POST' }).then((response) =>
      response.json()
    )) as { access_token: string };
    const image = (await fetch(`${baseUrl}/images/generations`, { method: 'POST' }).then((response) =>
      response.json()
    )) as { data: Array<{ url: string }> };
    const search = (await fetch(`${baseUrl}/alpha/search`, { method: 'POST' }).then((response) => response.json())) as {
      results: Array<{ title: string }>;
    };
    const realtime = (await fetch(`${baseUrl}/realtime/calls`, { method: 'POST' }).then((response) =>
      response.json()
    )) as { status: string };

    expect(models.data).toHaveLength(2);
    expect(quota.windows[0].remaining_fraction).toBe(0.12);
    expect(token.access_token).toBe('emulator-access-token');
    expect(image.data[0].url).toContain('emulator.invalid');
    expect(search.results[0].title).toBe('Gateway emulator');
    expect(realtime.status).toBe('ready');
  });

  it.each([
    'responses',
    'chat/completions',
    'messages',
  ])('streams deterministic reasoning and usage from %s', async (path) => {
    const baseUrl = await emulator.start();
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'x-emulator-scenario': 'reasoning' },
      body: '{}',
    });
    const stream = await response.text();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream).toContain('Think.');
    expect(stream).toMatch(/input_tokens|prompt_tokens/);
  });

  it('selects tool and reasoning scenarios from normal client request fields', async () => {
    const baseUrl = await emulator.start();
    const tool = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: [{ type: 'function', name: 'lookup' }] }),
    }).then((response) => response.text());
    const reasoning = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoning: { effort: 'max' } }),
    }).then((response) => response.text());
    expect(tool).toContain('function_call');
    expect(reasoning).toContain('reasoning_text.delta');
  });

  it('invokes an advertised Codex tool once and completes after its result', async () => {
    const baseUrl = await emulator.start();
    const firstTurn = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'Run the command' }],
      }),
    }).then((response) => response.text());
    const secondTurn = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'gateway-tool-ok' }],
      }),
    }).then((response) => response.text());

    expect(firstTurn).toContain('exec_command');
    expect(firstTurn).toContain('gateway-tool-ok');
    expect(firstTurn).toContain('reasoning_content');
    expect(secondTurn).not.toContain('tool_calls');
    expect(secondTurn).toContain('The command output was `gateway-tool-ok`.');
  });

  it.each([
    ['unauthorized', 401],
    ['rate_limited', 429],
    ['unavailable', 503],
  ] as const)('emits the configured %s failure', async (scenario, status) => {
    const baseUrl = await emulator.start();
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'x-emulator-scenario': scenario },
    });
    expect(response.status).toBe(status);
  });

  it('supports missing usage and partial output fault injection', async () => {
    const baseUrl = await emulator.start();
    const missing = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'x-emulator-scenario': 'missing_usage' },
    }).then((response) => response.text());
    const partial = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'x-emulator-scenario': 'partial' },
    }).then((response) => response.text());
    expect(missing).not.toContain('input_tokens');
    expect(partial).toContain('output_text.delta');
    expect(partial).not.toContain('response.completed');
  });
});
