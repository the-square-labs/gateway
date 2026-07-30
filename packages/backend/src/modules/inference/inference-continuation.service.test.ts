import 'reflect-metadata';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import { InferenceContinuationService } from './inference-continuation.service.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'http://localhost/auth/callback';
  process.env.PKI_MASTER_KEY ||= '00'.repeat(32);
});

describe('InferenceContinuationService', () => {
  it('stores encrypted bounded state and isolates it by user', async () => {
    const values = new Map<string, string>();
    const redis = {
      set: vi.fn().mockImplementation(async (key: string, value: string) => values.set(key, value)),
      get: vi.fn().mockImplementation(async (key: string) => values.get(key) ?? null),
    };
    const service = new InferenceContinuationService(redis as never, new CryptoService('ab'.repeat(32)));
    const payload = {
      userId: 'user-1',
      model: 'model-1',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private prompt' }] }],
      output: [{ type: 'message' as const, id: 'msg-1', role: 'assistant' as const, text: 'private output' }],
      affinityKey: 'account-1',
    };

    await service.remember('resp-1', payload);
    const stored = values.get('inference:continuation:resp-1')!;

    expect(stored).not.toContain('private prompt');
    expect(stored).not.toContain('private output');
    await expect(service.load('resp-1', 'user-1')).resolves.toMatchObject({ status: 'found', payload });
    await expect(service.load('resp-1', 'user-2')).resolves.toEqual({ status: 'forbidden' });
    expect(redis.set).toHaveBeenCalledWith('inference:continuation:resp-1', expect.any(String), 'EX', 86_400);
  });

  it('rejects continuation payloads above the configured bound', async () => {
    const service = new InferenceContinuationService(
      { set: vi.fn(), get: vi.fn() } as never,
      new CryptoService('ab'.repeat(32))
    );
    await expect(
      service.remember('resp-large', {
        userId: 'user-1',
        model: 'model-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_100_000) }] }],
        output: [],
      })
    ).rejects.toThrow('exceeds the configured size limit');
  });
});
