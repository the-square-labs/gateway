import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { NotificationDeliveryService } from './notification-delivery.service.js';

const DELIVERY = {
  id: '55555555-5555-4555-8555-555555555555',
  requestUrl: 'https://hooks.example.test/services/T/B/secret-token',
  requestBody: '{"authorization":"secret"}',
  responseBody: '{"token":"secret"}',
};

function serviceFor(row: typeof DELIVERY) {
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const db = { select: vi.fn().mockReturnValue({ from }) } as unknown as DrizzleClient;
  return new NotificationDeliveryService(db);
}

describe('NotificationDeliveryService.getById', () => {
  it('redacts webhook credentials and payloads by default', async () => {
    const result = await serviceFor(DELIVERY).getById(DELIVERY.id);

    expect(result).toEqual({
      ...DELIVERY,
      requestUrl: 'https://hooks.example.test/********',
      requestBody: null,
      responseBody: null,
    });
  });

  it('reveals delivery details only when explicitly requested', async () => {
    await expect(serviceFor(DELIVERY).getById(DELIVERY.id, { revealSensitive: true })).resolves.toEqual(DELIVERY);
  });
});
