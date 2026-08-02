import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import { AuthEmailQueueService } from './auth-email-queue.service.js';

const bullmq = vi.hoisted(() => ({
  queueAdd: vi.fn().mockResolvedValue(undefined),
  queueClose: vi.fn().mockResolvedValue(undefined),
  workerClose: vi.fn().mockResolvedValue(undefined),
  workerOn: vi.fn(),
  processor: undefined as
    | undefined
    | ((job: { data: { encryptedKey: string; encryptedDek: string } }) => Promise<void>),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = bullmq.queueAdd;
    close = bullmq.queueClose;
  },
  Worker: class {
    constructor(
      _name: string,
      processor: (job: { data: { encryptedKey: string; encryptedDek: string } }) => Promise<void>
    ) {
      bullmq.processor = processor;
    }

    on = bullmq.workerOn;
    close = bullmq.workerClose;
  },
}));

describe('AuthEmailQueueService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bullmq.processor = undefined;
  });

  function createService() {
    const workerRedis = { quit: vi.fn().mockResolvedValue(undefined) };
    const redis = { duplicate: vi.fn().mockReturnValue(workerRedis) };
    const cryptoService = new CryptoService('a'.repeat(64));
    return {
      service: new AuthEmailQueueService(redis as any, cryptoService),
      cryptoService,
      workerRedis,
    };
  }

  it('stores an encrypted delivery payload in Redis', async () => {
    const { service, cryptoService } = createService();

    await service.enqueue('user@example.com', {
      kind: 'password_reset',
      actionUrl: 'https://gateway.example/reset-password?token=one-time-secret',
    });

    const [, encrypted] = bullmq.queueAdd.mock.calls[0];
    expect(JSON.stringify(encrypted)).not.toContain('one-time-secret');
    expect(JSON.parse(cryptoService.decryptString(encrypted))).toEqual({
      recipient: 'user@example.com',
      input: {
        kind: 'password_reset',
        actionUrl: 'https://gateway.example/reset-password?token=one-time-secret',
      },
    });
  });

  it('decrypts a queued message only for the delivery worker and closes its resources', async () => {
    const { service, cryptoService, workerRedis } = createService();
    const delivery = vi.fn().mockResolvedValue(undefined);
    service.start(delivery);
    const encrypted = cryptoService.encryptString(
      JSON.stringify({ recipient: 'user@example.com', input: { kind: 'email_otp', code: '123456' } })
    );

    await bullmq.processor?.({ data: encrypted });
    await service.close();

    expect(delivery).toHaveBeenCalledWith({
      recipient: 'user@example.com',
      input: { kind: 'email_otp', code: '123456' },
    });
    expect(bullmq.workerClose).toHaveBeenCalledOnce();
    expect(bullmq.queueClose).toHaveBeenCalledOnce();
    expect(workerRedis.quit).toHaveBeenCalledOnce();
  });
});
