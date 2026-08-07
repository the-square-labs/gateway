import { describe, expect, it, vi } from 'vitest';
import {
  normalizeRelayCertificateSerial,
  RelayAuthorizationRepository,
  type RelayAuthorizationRepositoryError,
  type RelayQueryClient,
} from './authorization-repository.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const DATABASE_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';

function repositoryWithRows(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const client: RelayQueryClient = { query };
  return { repository: RelayAuthorizationRepository.forTest(client), query };
}

describe('RelayAuthorizationRepository', () => {
  it('normalizes certificate serials before comparing them', () => {
    expect(normalizeRelayCertificateSerial(' AA:bb:01 ')).toBe('aabb01');
  });

  it('authenticates only an enrolled tunnel-capable node with the current serial', async () => {
    const { repository, query } = repositoryWithRows([
      { node_id: NODE_ID, node_type: 'docker', node_status: 'connected', certificate_serial: 'AA:BB' },
    ]);

    await expect(repository.authenticateNode(NODE_ID, 'aabb')).resolves.toEqual({
      nodeId: NODE_ID,
      nodeType: 'docker',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('gateway_relay_node_identities_v1'), [NODE_ID]);
  });

  it.each([
    { node_status: 'pending', node_type: 'docker', certificate_serial: 'aabb' },
    { node_status: 'connected', node_type: 'unknown', certificate_serial: 'aabb' },
    { node_status: 'connected', node_type: 'docker', certificate_serial: 'different' },
  ])('rejects an unauthorized node identity %#', async (override) => {
    const { repository } = repositoryWithRows([{ node_id: NODE_ID, ...override }]);
    await expect(repository.authenticateNode(NODE_ID, 'aabb')).resolves.toBeNull();
  });

  it('authorizes only a ready binding owned by the source node', async () => {
    const { repository, query } = repositoryWithRows([
      {
        binding_id: BINDING_ID,
        managed_database_id: DATABASE_ID,
        source_node_id: SOURCE_ID,
        binding_status: 'ready',
        database_node_id: NODE_ID,
        database_status: 'ready',
      },
    ]);

    await expect(repository.authorizeBinding(BINDING_ID, DATABASE_ID, SOURCE_ID)).resolves.toEqual({
      bindingId: BINDING_ID,
      managedDatabaseId: DATABASE_ID,
      sourceNodeId: SOURCE_ID,
      databaseNodeId: NODE_ID,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('gateway_relay_bindings_v1'), [BINDING_ID, DATABASE_ID]);
  });

  it('authorizes a ready managed database for an app-owned tunnel', async () => {
    const { repository } = repositoryWithRows([
      { managed_database_id: DATABASE_ID, database_node_id: NODE_ID, database_status: 'ready' },
    ]);
    await expect(repository.authorizeManagedDatabase(DATABASE_ID)).resolves.toEqual({
      managedDatabaseId: DATABASE_ID,
      databaseNodeId: NODE_ID,
    });
  });

  it('groups active binding reconciliation into one view query', async () => {
    const { repository, query } = repositoryWithRows([{ binding_id: BINDING_ID }]);
    await expect(repository.readyBindingIds([BINDING_ID, BINDING_ID, 'invalid'])).resolves.toEqual(
      new Set([BINDING_ID])
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('gateway_relay_bindings_v1');
    expect(query.mock.calls[0]?.[1]).toEqual([[BINDING_ID]]);
  });

  it('classifies a missing versioned view as a contract mismatch', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('missing view'), { code: '42P01' }));
    const repository = RelayAuthorizationRepository.forTest({ query });

    await expect(repository.checkContract()).rejects.toMatchObject({
      reason: 'contract_mismatch',
    } satisfies Partial<RelayAuthorizationRepositoryError>);
  });

  it('never queries base tables or credential columns', async () => {
    const queries: string[] = [];
    const repository = RelayAuthorizationRepository.forTest({
      async query(text) {
        queries.push(text);
        return { rows: [] };
      },
    });
    await repository.checkContract();
    await repository.authenticateNode(NODE_ID, 'aa');
    await repository.authorizeBinding(BINDING_ID, DATABASE_ID, SOURCE_ID);
    await repository.authorizeManagedDatabase(DATABASE_ID);
    await repository.readyBindingIds([BINDING_ID]);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).not.toMatch(/\bfrom\s+(nodes|managed_database_instances|managed_database_bindings)\b/);
    expect(sql).not.toMatch(/password|credential|connection_string|database_url/);
  });
});
