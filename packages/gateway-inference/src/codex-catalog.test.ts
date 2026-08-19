import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCodexCatalog, withFileLock } from './codex-catalog.js';

const MODELS = {
  object: 'list',
  data: [
    {
      id: 'gateway-model',
      object: 'model',
      created: 1,
      owned_by: 'gateway',
      display_name: 'Gateway Model',
      context_window: 128_000,
      max_input_tokens: 120_000,
      max_output_tokens: 8_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      capabilities: { tools: true, reasoning: true },
      supported_reasoning_efforts: ['medium', 'high'],
      default_reasoning_effort: 'medium',
      supported_service_tiers: [],
    },
  ],
};

// The local catalog file keeps the Codex `model_catalog_json` shape; only the
// downloaded payload changed to the standard model list.
const EXISTING_CATALOG = {
  models: [
    {
      slug: 'gateway-model',
      display_name: 'Gateway Model',
      description: 'Test',
      visibility: 'list',
      supported_in_api: true,
      base_instructions: 'Use tools.',
      context_window: 128_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      supported_reasoning_levels: [],
    },
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codex-catalog-'));
  return {
    root,
    catalogFile: join(root, 'catalog.json'),
    metadataFile: join(root, 'metadata.json'),
    lockFile: join(root, 'catalog.lock'),
  };
}

describe('Codex catalog synchronization', () => {
  it('downloads the standard model list, converts it, and then uses If-None-Match', async () => {
    const files = await fixture();
    const calls: Request[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Request(input, init));
      if (calls.length === 2) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(MODELS), {
        headers: { 'Content-Type': 'application/json', ETag: '"catalog-v1"' },
      });
    }) as typeof fetch;
    const input = {
      modelsUrl: 'https://gateway.example/api/inference/v1/models',
      token: 'gwi_secret',
      ...files,
      fetch: fetcher,
      now: () => new Date('2026-07-28T00:00:00Z'),
    };

    await expect(syncCodexCatalog(input)).resolves.toMatchObject({
      status: 'updated',
      catalogVersion: 'catalog-v1',
      modelCount: 1,
    });
    await expect(syncCodexCatalog(input)).resolves.toMatchObject({ status: 'unchanged', modelCount: 1 });
    expect(calls[0].url).toBe('https://gateway.example/api/inference/v1/models');
    expect(calls[0].headers.get('authorization')).toBe('Bearer gwi_secret');
    expect(calls[1].headers.get('if-none-match')).toBe('"catalog-v1"');
    const written = JSON.parse(await readFile(files.catalogFile, 'utf8'));
    expect(written.models).toHaveLength(1);
    expect(written.models[0]).toMatchObject({
      slug: 'gateway-model',
      display_name: 'Gateway Model',
      visibility: 'list',
      supported_in_api: true,
      priority: 0,
      context_window: 128_000,
      auto_compact_token_limit: 100_000,
      input_modalities: ['text'],
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'medium', description: expect.any(String) },
        { effort: 'high', description: expect.any(String) },
      ],
    });
  });

  it('retains the last-good catalog when Gateway is offline or returns 5xx', async () => {
    const files = await fixture();
    await writeFile(files.catalogFile, JSON.stringify(EXISTING_CATALOG));
    await writeFile(
      files.metadataFile,
      JSON.stringify({ etag: '"old"', catalogVersion: 'old', lastSyncedAt: '2026-07-27T00:00:00Z' })
    );

    const offline = await syncCodexCatalog({
      modelsUrl: 'https://gateway.example/api/inference/v1/models',
      token: 'gwi_secret',
      ...files,
      fetch: vi.fn().mockRejectedValue(new Error('offline')) as typeof fetch,
    });
    const upstreamFailure = await syncCodexCatalog({
      modelsUrl: 'https://gateway.example/api/inference/v1/models',
      token: 'gwi_secret',
      ...files,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as typeof fetch,
    });

    expect(offline.status).toBe('stale');
    expect(upstreamFailure.status).toBe('stale');
    expect(JSON.parse(await readFile(files.catalogFile, 'utf8'))).toEqual(EXISTING_CATALOG);
  });

  it('never recreates a revoked runtime token and preserves a good catalog on invalid replacement', async () => {
    const files = await fixture();
    await writeFile(files.catalogFile, JSON.stringify(EXISTING_CATALOG));
    const base = {
      modelsUrl: 'https://gateway.example/api/inference/v1/models',
      token: 'gwi_revoked',
      ...files,
    };

    await expect(
      syncCodexCatalog({
        ...base,
        fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })) as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'RUNTIME_TOKEN_REVOKED' });
    await expect(
      syncCodexCatalog({
        ...base,
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ object: 'list', data: [] }))) as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'CATALOG_EMPTY' });
    await expect(
      syncCodexCatalog({
        ...base,
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ object: 'list', data: [{ id: 'gateway-model' }] }))
          ) as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'CATALOG_INVALID' });
    expect(JSON.parse(await readFile(files.catalogFile, 'utf8'))).toEqual(EXISTING_CATALOG);
  });

  it('serializes concurrent refresh operations with one profile lock', async () => {
    const files = await fixture();
    const order: string[] = [];
    let acquired!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = withFileLock(files.lockFile, async () => {
      order.push('first-start');
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 75));
      order.push('first-end');
    });
    await firstAcquired;
    const second = withFileLock(files.lockFile, async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
