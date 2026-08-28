import { describe, expect, it, vi } from 'vitest';
import { LoggingEnvironmentService } from './logging-environment.service.js';

const ENVIRONMENT = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Production',
  slug: 'production',
  description: null,
  enabled: true,
  schemaId: null,
  schemaMode: 'loose',
  retentionDays: 30,
  rateLimitRequestsPerWindow: null,
  rateLimitEventsPerWindow: null,
  fieldSchema: [],
  createdById: '11111111-1111-4111-8111-111111111111',
  createdAt: new Date('2026-04-27T00:00:00.000Z'),
  updatedAt: new Date('2026-04-27T00:00:00.000Z'),
};

function createService(storage = { deleteEnvironmentLogs: vi.fn().mockResolvedValue(undefined) }) {
  const whereUpdate = vi.fn().mockResolvedValue(undefined);
  const setUpdate = vi.fn().mockReturnValue({ where: whereUpdate });
  const whereDelete = vi.fn().mockResolvedValue(undefined);
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([ENVIRONMENT]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: setUpdate,
    }),
    delete: vi.fn().mockReturnValue({
      where: whereDelete,
    }),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  return {
    db,
    auditService,
    storage,
    service: new LoggingEnvironmentService(db as any, auditService as any, storage),
    setUpdate,
    whereUpdate,
    whereDelete,
  };
}

describe('LoggingEnvironmentService', () => {
  it('disables ingest and deletes ClickHouse log rows before deleting an environment record', async () => {
    const { service, storage, whereUpdate, whereDelete } = createService();

    await service.delete(ENVIRONMENT.id, 'user-1');

    expect(whereUpdate).toHaveBeenCalledOnce();
    expect(storage.deleteEnvironmentLogs).toHaveBeenCalledWith(ENVIRONMENT.id);
    expect(whereDelete).toHaveBeenCalledOnce();
    expect(whereUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      storage.deleteEnvironmentLogs.mock.invocationCallOrder[0]
    );
    expect(storage.deleteEnvironmentLogs.mock.invocationCallOrder[0]).toBeLessThan(
      whereDelete.mock.invocationCallOrder[0]
    );
  });

  it('does not delete the environment record when ClickHouse cleanup fails', async () => {
    const storage = { deleteEnvironmentLogs: vi.fn().mockRejectedValue(new Error('clickhouse down')) };
    const { service, setUpdate, whereDelete } = createService(storage);

    await expect(service.delete(ENVIRONMENT.id, 'user-1')).rejects.toThrow('clickhouse down');

    expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(whereDelete).not.toHaveBeenCalled();
  });

  it('keeps the environment disabled when the database delete fails after ClickHouse cleanup', async () => {
    const { service, setUpdate, whereDelete } = createService();
    whereDelete.mockRejectedValue(new Error('database down'));

    await expect(service.delete(ENVIRONMENT.id, 'user-1')).rejects.toThrow('database down');

    expect(setUpdate).toHaveBeenCalledTimes(1);
    expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
