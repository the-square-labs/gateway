import { describe, expect, it, vi } from 'vitest';
import { DatabaseConnectionService } from './databases.service.js';

const availableExtensions = [
  {
    name: 'pg_stat_statements',
    default_version: '1.11',
    comment: 'track planning and execution statistics of all SQL statements executed',
  },
  {
    name: 'plpgsql',
    default_version: '1.0',
    comment: 'PL/pgSQL procedural language',
  },
  {
    name: 'uuid-ossp',
    default_version: '1.1',
    comment: 'generate universally unique identifiers (UUIDs)',
  },
];

function createService() {
  const log = vi.fn().mockResolvedValue(undefined);
  const service = new DatabaseConnectionService({} as never, { log } as never, {} as never);
  vi.spyOn(
    service as unknown as { getManagedPostgresExtensionContext: () => Promise<{ imageRef: string }> },
    'getManagedPostgresExtensionContext'
  ).mockResolvedValue({ imageRef: 'postgres@sha256:image-1' });
  return { log, service };
}

function mockPool(service: DatabaseConnectionService) {
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('from pg_extension')) {
        return { rows: [{ name: 'plpgsql', installed_version: '1.0' }] };
      }
      if (sql.includes('pg_available_extensions')) return { rows: availableExtensions };
      return { rows: [] };
    }),
  };
  vi.spyOn(service, 'getPostgresPool').mockResolvedValue(pool as never);
  return pool;
}

describe('DatabaseConnectionService managed PostgreSQL extensions', () => {
  it('lists only extensions that Gateway can manage from the actual image catalog', async () => {
    const { service } = createService();
    mockPool(service);

    await expect(service.listManagedPostgresExtensions('db-1')).resolves.toEqual([
      expect.objectContaining({ name: 'uuid-ossp', installedVersion: null }),
    ]);
  });

  it('enables only an available extension and quotes its PostgreSQL identifier', async () => {
    const { log, service } = createService();
    const pool = mockPool(service);

    await service.enableManagedPostgresExtension('db-1', 'uuid-ossp', 'user-1');

    expect(pool.query).toHaveBeenCalledWith('create extension if not exists "uuid-ossp"');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'database.postgres.extension.enable', resourceId: 'db-1' })
    );
  });

  it('warms and serves the extension snapshot without a later PostgreSQL query', async () => {
    const { service } = createService();
    const pool = mockPool(service);

    await Promise.all([
      service.warmManagedPostgresExtensionCatalog('db-1'),
      service.listManagedPostgresExtensions('db-1'),
    ]);

    expect(pool.query.mock.calls.filter(([sql]) => String(sql).includes('pg_available_extensions'))).toHaveLength(1);
    expect(pool.query.mock.calls.filter(([sql]) => String(sql).includes('from pg_extension'))).toHaveLength(1);
    await expect(service.enableManagedPostgresExtension('db-1', 'pg_stat_statements', 'user-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'POSTGRES_EXTENSION_NOT_AVAILABLE',
    });
  });
});
