import { describe, expect, it, vi } from 'vitest';
import { RelayPoolService } from './relay-pool.service.js';

const nodeId = '11111111-1111-4111-8111-111111111111';

/** A remote relay whose supervisor lost its control stream. */
function offlineRelay(state: 'offline' | 'draining' = 'offline', drained = state === 'draining') {
  const instance = {
    id: 'relay-1',
    poolId: 'system',
    kind: 'remote',
    nodeId,
    state,
    manualDrainStartedAt: drained ? new Date() : null,
    drainForcedAt: null,
    health: {},
  };
  const persisted: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [instance] }) }) })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        persisted.push(values);
        return { where: async () => undefined };
      },
    })),
  };
  const policy = {
    isRemoteInstanceConnected: vi.fn(() => false),
    setRemoteInstanceDrain: vi.fn(async () => {
      throw new Error(`Node ${nodeId} is not connected`);
    }),
    reconcileAndSync: vi.fn(async () => undefined),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const events = { publish: vi.fn() };
  const service = new RelayPoolService(db as never, policy as never, events as never, audit as never, {} as never);
  const evacuate = vi
    .spyOn(service as unknown as { evacuateInstance(id: string): Promise<void> }, 'evacuateInstance')
    .mockResolvedValue(undefined);
  return { service, policy, audit, persisted, evacuate };
}

describe('Relay drain while the relay is not connected', () => {
  it('records the drain for the relay to receive when it reconnects', async () => {
    const { service, policy, audit, persisted, evacuate } = offlineRelay();

    await service.drainInstance('relay-1', 'admin-1', true);

    expect(policy.setRemoteInstanceDrain).not.toHaveBeenCalled();
    // The intent is durable and the relay keeps its offline state until it reports again.
    expect(persisted).toEqual([expect.objectContaining({ state: 'offline', manualDrainStartedAt: expect.anything() })]);
    expect(policy.reconcileAndSync).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.instance.drain' }));
    expect(evacuate).toHaveBeenCalledWith('relay-1');
  });

  it('refuses to resume it with a reason instead of failing', async () => {
    const { service, persisted } = offlineRelay('draining');

    await expect(service.drainInstance('relay-1', 'admin-1', false)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_NOT_CONNECTED',
    });
    expect(persisted).toEqual([]);
  });

  it('refuses to force-disconnect it with a reason instead of failing', async () => {
    const { service, persisted } = offlineRelay('draining');

    await expect(service.forceDisconnectInstance('relay-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_NOT_CONNECTED',
    });
    expect(persisted).toEqual([]);
  });

  it('says it is not connected when it was just drained and keeps its offline state', async () => {
    const { service, persisted, policy } = offlineRelay('offline', true);

    await expect(service.forceDisconnectInstance('relay-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELAY_NOT_CONNECTED',
    });
    expect(policy.setRemoteInstanceDrain).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
  });
});
