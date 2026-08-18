import { describe, expect, it, vi } from 'vitest';
import { PAGE_RUNTIME_CONFIG_MAX_BYTES } from './page-runtime-config.schemas.js';
import {
  PageRuntimeConfigService,
  parsePageRuntimeConfigSource,
  withPageDefaultRuntimeConfigLock,
} from './page-runtime-config.service.js';

describe('Page runtime configuration validation', () => {
  it('accepts JSON objects without changing their values', () => {
    expect(parsePageRuntimeConfigSource('{"api":"/v1","flags":{"newUi":true}}')).toEqual({
      api: '/v1',
      flags: { newUi: true },
    });
  });

  it.each(['null', '[]', '"value"', 'true', '42'])('rejects non-object JSON: %s', (source) => {
    expect(() => parsePageRuntimeConfigSource(source)).toThrowError(
      expect.objectContaining({ code: 'PAGE_RUNTIME_CONFIG_OBJECT_REQUIRED' })
    );
  });

  it('rejects malformed JSON and values larger than 64 KiB', () => {
    expect(() => parsePageRuntimeConfigSource('{')).toThrowError(
      expect.objectContaining({ code: 'PAGE_RUNTIME_CONFIG_INVALID_JSON' })
    );
    const oversized = JSON.stringify({ value: 'x'.repeat(PAGE_RUNTIME_CONFIG_MAX_BYTES) });
    expect(() => parsePageRuntimeConfigSource(oversized)).toThrowError(
      expect.objectContaining({ code: 'PAGE_RUNTIME_CONFIG_TOO_LARGE' })
    );
  });
});

describe('Pages Default runtime configuration lock', () => {
  it('holds one PostgreSQL session advisory lock through the protected publication work', async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn().mockImplementation(async () => order.push('query')),
      release: vi.fn().mockImplementation(() => order.push('release')),
    };
    const db = { $client: { connect: vi.fn().mockResolvedValue(client) } };

    const result = await withPageDefaultRuntimeConfigLock(db as never, 'project-1', async () => {
      order.push('publish');
      return 'published';
    });

    expect(result).toBe('published');
    expect(order).toEqual(['query', 'publish', 'query', 'release']);
    expect(client.query).toHaveBeenNthCalledWith(1, 'select pg_advisory_lock(hashtextextended($1, 0))', [
      'gateway-pages-default-runtime-config:project-1',
    ]);
    expect(client.query).toHaveBeenNthCalledWith(2, 'select pg_advisory_unlock(hashtextextended($1, 0))', [
      'gateway-pages-default-runtime-config:project-1',
    ]);
  });

  it('keeps the lock through the complete Default save and publication flow', async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn().mockImplementation(async () => order.push('query')),
      release: vi.fn().mockImplementation(() => order.push('release')),
    };
    const db = { $client: { connect: vi.fn().mockResolvedValue(client) } };
    const service = new PageRuntimeConfigService(db as never, {} as never);
    vi.spyOn(service as any, 'save').mockImplementation(async () => {
      order.push('save-and-publish');
      return {};
    });

    await service.saveDefault('project-1', { source: '{}', expectedGeneration: 0 }, 'user-1');

    expect(order).toEqual(['query', 'save-and-publish', 'query', 'release']);
  });
});
