import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import { AuthMailService } from './auth-mail.service.js';

describe('AuthMailService.sendSecurityEmail', () => {
  it('queues verified security email instead of waiting for SMTP delivery', async () => {
    const cryptoService = new CryptoService('a'.repeat(64));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                value: {
                  host: 'smtp.example.com',
                  port: 587,
                  tlsMode: 'starttls',
                  username: 'smtp-user',
                  senderName: 'Gateway',
                  senderEmail: 'gateway@example.com',
                  password: cryptoService.encryptString('smtp-password'),
                  verifiedAt: '2026-08-02T00:00:00.000Z',
                },
              },
            ]),
          })),
        })),
      })),
    };
    const authEmailQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = new AuthMailService(db as any, cryptoService, authEmailQueue as any);

    await service.sendSecurityEmail('user@example.com', { kind: 'email_otp', code: '123456' });

    expect(authEmailQueue.enqueue).toHaveBeenCalledWith('user@example.com', {
      kind: 'email_otp',
      code: '123456',
    });
  });
});
