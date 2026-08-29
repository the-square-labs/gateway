import { describe, expect, it, vi } from 'vitest';
import { NodesService } from '@/modules/nodes/nodes.service.js';

type QuerySelection = unknown[] | { limit: () => Promise<unknown[]> };

const limited = (rows: unknown[]) => ({ limit: vi.fn(async () => rows) });

function createSelectDb(selections: QuerySelection[]) {
  const pendingSelections = [...selections];

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const selection = pendingSelections.shift();
          if (selection && !Array.isArray(selection) && 'limit' in selection) {
            return selection;
          }
          return Promise.resolve(selection ?? []);
        }),
      })),
    })),
  };
}

function createService(
  db: unknown,
  options?: {
    auditService?: unknown;
    registry?: unknown;
    eventBus?: unknown;
  }
) {
  const service = new NodesService(
    db as never,
    (options?.auditService ?? { log: vi.fn(async () => undefined) }) as never,
    (options?.registry ?? { getNode: vi.fn() }) as never,
    {} as never,
    {} as never
  );

  if (options?.eventBus) {
    service.setEventBus(options.eventBus as never);
  }

  return service;
}

describe('NodesService characterization', () => {
  it('uses the connected node health report for public and effective addresses while hiding health history', async () => {
    const persistedHealthHistory = [{ status: 'online', observedAt: '2026-08-28T12:00:00.000Z' }];
    const node = {
      id: 'node-1',
      type: 'nginx',
      hostname: 'edge.local',
      displayName: 'Edge',
      slug: 'edge-local',
      status: 'online',
      serviceAddresses: [],
      serviceAddress: null,
      secondaryServiceAddress: null,
      lastHealthReport: {
        localIpAddresses: ['192.168.1.20'],
        publicIpAddresses: ['8.8.8.8'],
      },
      healthHistory: persistedHealthHistory,
    };
    const liveHealthReport = {
      localIpAddresses: ['10.0.0.20'],
      publicIpAddresses: ['1.1.1.1'],
    };
    const liveStatsReport = { cpuPercent: 42 };
    const registry = {
      getNode: vi.fn(() => ({ lastHealthReport: liveHealthReport, lastStatsReport: liveStatsReport })),
    };
    const service = createService(createSelectDb([limited([node])]), { registry });

    const result = await service.get(node.id);

    expect(result).toMatchObject({
      id: node.id,
      publicServiceAddresses: ['1.1.1.1'],
      effectiveServiceAddress: '1.1.1.1',
      status: 'online',
      isConnected: true,
      liveHealthReport,
      liveStatsReport,
    });
    expect(result).not.toHaveProperty('healthHistory');
    expect(registry.getNode).toHaveBeenCalledWith(node.id);
  });

  it('returns stored health history, defaults null history to an empty list, and reports a missing node', async () => {
    const history = [{ status: 'degraded', observedAt: '2026-08-28T12:00:00.000Z' }];
    const storedHistoryService = createService(createSelectDb([limited([{ healthHistory: history }])]));
    const emptyHistoryService = createService(createSelectDb([limited([{ healthHistory: null }])]));
    const missingNodeService = createService(createSelectDb([limited([])]));

    await expect(storedHistoryService.getHealthHistory('node-1')).resolves.toEqual(history);
    await expect(emptyHistoryService.getHealthHistory('node-1')).resolves.toEqual([]);
    await expect(missingNodeService.getHealthHistory('missing-node')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

});
