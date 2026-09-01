import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/middleware/error-handler.js';
import { SiemDeliveryService } from './siem-delivery.service.js';

function createUpdateMock(rows: Array<{ id: string; destinationId: string; status: string }>) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return { set, update: vi.fn(() => ({ set })) };
}

describe('SiemDeliveryService', () => {
  it('releases a claimed batch without sending when SIEM is disabled mid-run', async () => {
    const featureState = {
      isFeatureEnabled: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    };
    const service = new SiemDeliveryService({} as never, {} as never, featureState as never);
    service.setLicensePolicyService({
      hasFeature: vi.fn().mockResolvedValue(true),
      hasFeatureForExistingRuntime: vi.fn().mockResolvedValue(true),
      requireFeature: vi.fn().mockResolvedValue(undefined),
    } as never);
    const batch = {
      destination: {
        id: 'destination-1',
        url: 'https://collector.example.test/audit',
        authType: 'bearer',
        customHeaderName: null,
        encryptedSecret: '{}',
      },
      deliveries: [
        {
          id: 'delivery-1',
          destinationId: 'destination-1',
          payload: {} as never,
          attempt: 1,
          maxAttempts: 8,
        },
      ],
      leaseToken: '11111111-1111-4111-8111-111111111111',
    };
    const internal = service as unknown as {
      recoverExpiredLeases: () => Promise<void>;
      claimNextBatch: () => Promise<typeof batch | null>;
      releaseClaimedBatch: (claimed: typeof batch) => Promise<void>;
      deliver: (claimed: typeof batch) => Promise<void>;
    };
    vi.spyOn(internal, 'recoverExpiredLeases').mockResolvedValue(undefined);
    vi.spyOn(internal, 'claimNextBatch').mockResolvedValue(batch);
    const releaseClaimedBatch = vi.spyOn(internal, 'releaseClaimedBatch').mockResolvedValue(undefined);
    const deliver = vi.spyOn(internal, 'deliver').mockResolvedValue(undefined);

    await service.runDueDeliveries();

    expect(releaseClaimedBatch).toHaveBeenCalledWith(batch);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('checks SIEM enablement immediately before a claimed batch reaches transport', async () => {
    const limit = vi.fn().mockResolvedValue([{ id: 'destination-1', enabled: true, deletedAt: null }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const transport = { send: vi.fn() };
    const featureState = { isFeatureEnabled: vi.fn().mockResolvedValue(false) };
    const service = new SiemDeliveryService(db as never, transport as never, featureState as never);
    const batch = {
      destination: {
        id: 'destination-1',
        url: 'https://collector.example.test/audit',
        authType: 'bearer',
        customHeaderName: null,
        encryptedSecret: '{}',
      },
      deliveries: [],
      leaseToken: '11111111-1111-4111-8111-111111111111',
    };
    const internal = service as unknown as {
      deliver: (claimed: typeof batch) => Promise<void>;
      releaseClaimedBatch: (claimed: typeof batch) => Promise<void>;
    };
    const releaseClaimedBatch = vi.spyOn(internal, 'releaseClaimedBatch').mockResolvedValue(undefined);

    await internal.deliver(batch);

    expect(releaseClaimedBatch).toHaveBeenCalledWith(batch);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('requeues only failed deliveries and clears terminal failure state', async () => {
    const query = createUpdateMock([{ id: 'delivery-1', destinationId: 'destination-1', status: 'queued' }]);
    const service = new SiemDeliveryService({ update: query.update } as never, {} as never);
    service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as never);

    await expect(service.requeue('delivery-1')).resolves.toEqual({
      id: 'delivery-1',
      destinationId: 'destination-1',
      status: 'queued',
    });
    expect(query.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued',
        attempt: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        error: null,
      })
    );
    expect(eventBus.publish).toHaveBeenCalledWith('siem.delivery.changed', {
      destinationId: 'destination-1',
      action: 'requeued',
    });
  });

  it('refuses to requeue deliveries that are not terminal failures', async () => {
    const query = createUpdateMock([]);
    const service = new SiemDeliveryService({ update: query.update } as never, {} as never);
    service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);

    await expect(service.requeue('delivery-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SIEM_DELIVERY_NOT_REQUEUEABLE',
    } satisfies Partial<AppError>);
  });
});
