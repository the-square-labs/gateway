import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingOperations, hostingResources } from '@/db/schema/hosting.js';
import { HostingOperationsService, hostingRequestHash, publicHostingOperation } from './hosting-operations.service.js';

describe('hosting durable-operation contracts', () => {
  it('commits entity finalization with the fenced terminal operation before publishing', async () => {
    const updated = { id: 'op', action: 'snapshot_create', phase: 'ready', request: {}, resourceId: 'vm' };
    const tx = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [updated] }) }) }) };
    const events = { publish: vi.fn() };
    const finalized = vi.fn(async (transaction: unknown) => {
      expect(transaction).toBe(tx);
      expect(events.publish).not.toHaveBeenCalled();
    });
    const db = { transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) };
    const service = new HostingOperationsService(db as never, events as never);
    const row = { ...updated, phase: 'provisioning' };
    await service.finish(row as never, 'ready', undefined, undefined, finalized);
    expect(finalized).toHaveBeenCalledOnce();
    expect(events.publish).toHaveBeenCalledOnce();
    events.publish.mockClear();
    finalized.mockRejectedValueOnce(Error('entity update failed'));
    await expect(service.finish(row as never, 'ready', undefined, undefined, finalized)).rejects.toThrow(
      'entity update failed'
    );
    expect(events.publish).not.toHaveBeenCalled();
    finalized.mockResolvedValueOnce();
    events.publish.mockImplementationOnce(() => {
      throw Error('listener failed');
    });
    await expect(service.finish(row as never, 'ready', undefined, undefined, finalized)).resolves.toMatchObject({
      phase: 'ready',
    });
  });
  it('emits a safe terminal event after a fenced write, but never on lease renewal or lost ownership', async () => {
    const updated = {
      id: 'op',
      connectorId: 'account',
      resourceId: 'vm',
      nodeId: 'node',
      action: 'snapshot_create',
      phase: 'ready',
      request: { name: 'VM', token: 'secret' },
      errorCode: null,
      errorMessage: null,
    };
    const returning = vi.fn(async () => [updated]);
    const db = { update: () => ({ set: () => ({ where: () => ({ returning }) }) }) };
    const events = { publish: vi.fn() };
    const service = new HostingOperationsService(db as never, events as never);
    const row = { ...updated, phase: 'provisioning', generation: 1 };
    await service.update(row as never, { phase: 'ready' });
    expect(events.publish).toHaveBeenCalledWith(
      'hosting.operation.changed',
      expect.objectContaining({ resourceId: 'vm', action: 'snapshot_create', phase: 'ready' })
    );
    expect(JSON.stringify(events.publish.mock.calls)).not.toContain('secret');
    await service.renew(row as never);
    expect(events.publish).toHaveBeenCalledTimes(1);
    returning.mockResolvedValueOnce([]);
    await expect(service.update(row as never, { phase: 'failed' })).rejects.toThrow('ownership changed');
    expect(events.publish).toHaveBeenCalledTimes(1);
  });
  it('keeps the same paid intent hash through reordered requests and different client retry keys', () => {
    expect(hostingRequestHash('create', 'actor', { name: 'vm', size: 's', idempotencyKey: 'one' })).toBe(
      hostingRequestHash('create', 'actor', { size: 's', idempotencyKey: 'two', name: 'vm' })
    );
    expect(hostingRequestHash('create', 'actor', { name: 'vm', size: 's' })).not.toBe(
      hostingRequestHash('create', 'other', { name: 'vm', size: 's' })
    );
    expect(hostingRequestHash('topup', 'actor', { amount: '10', currency: 'USD' })).not.toBe(
      hostingRequestHash('topup', 'actor', { amount: '10', currency: 'EUR' })
    );
  });
  it('does not expose bootstrap secrets, provider payloads, actor or internal request state', () => {
    const input = {
      id: 'op',
      action: 'create',
      phase: 'enrolling',
      request: { token: 'secret' },
      encryptedBootstrap: 'ciphertext',
      providerOperation: { error: 'private' },
      requestHash: 'hash',
      actorId: 'actor',
      result: { ready: true },
    };
    const output = publicHostingOperation(input as never);
    expect(output).toMatchObject({ id: 'op', phase: 'enrolling', result: { ready: true } });
    for (const key of ['request', 'encryptedBootstrap', 'providerOperation', 'requestHash', 'actorId'])
      expect(output).not.toHaveProperty(key);
  });
  it('projects only safe node identity fields before the provider VM exists', () => {
    const output = publicHostingOperation({
      id: 'op',
      nodeId: 'node',
      phase: 'pending',
      action: 'create',
      request: {
        name: 'worker',
        role: 'docker',
        location: 'fra1',
        token: 'secret',
        proxmoxProfile: { password: 'secret' },
      },
      encryptedBootstrap: 'private',
    } as never);
    expect(output.node).toEqual({ id: 'node', name: 'worker', type: 'docker', location: 'fra1' });
    expect(JSON.stringify(output)).not.toContain('secret');
    expect(JSON.stringify(output)).not.toContain('private');
  });
  it('enforces DB uniqueness for paid requests and multi-role host bindings', () => {
    const operations = getTableConfig(hostingOperations);
    expect(operations.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'hosting_operation_intent_unique'
    );
    expect(operations.indexes.map((index) => index.config.name)).toContain('hosting_operation_request_active_unique');
    expect(operations.indexes.map((index) => index.config.name)).toContain('hosting_operation_resource_active_unique');
    const resources = getTableConfig(hostingResources);
    expect(resources.uniqueConstraints.map((constraint) => constraint.name)).toContain('hosting_resource_host_unique');
    expect(resources.indexes.map((index) => index.config.name)).toContain('hosting_resource_active_identity_unique');
    const bindings = getTableConfig(hostingNodeBindings);
    expect(bindings.foreignKeys.some((key) => key.reference().name === 'hosting_binding_resource_host_fk')).toBe(true);
  });
});
