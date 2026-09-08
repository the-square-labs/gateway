import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingResources, integrationConnectors, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { HostingSettingsSchema } from './hosting.schemas.js';
import { HostingInventoryService } from './hosting-inventory.service.js';

// Table-aware transaction double: run the real evidence matcher and commit path,
// while interleaving a configuration/permission change before transaction entry.
function fixture(resourceIds: string[] = []) {
  const now = new Date();
  const connector = {
    id: 'connector',
    enabled: true,
    updatedAt: now,
    settings: HostingSettingsSchema.parse({ resourceIds }),
  };
  let currentConnector: typeof connector | null = structuredClone(connector);
  const actor = { scopes: ['nodes:config:edit', 'nodes:details'] };
  const node = {
    id: 'node',
    hostIdentityId: 'host',
    lastSeenAt: now,
    lastHealthReport: { networkInterfaces: [{ name: 'eth0', ipAddresses: ['8.8.8.8/32'] }] },
  };
  const resource = {
    id: 'resource',
    connectorId: connector.id,
    remoteId: 'allowed-100',
    origin: 'discovered',
    managedHostIdentity: null,
    incarnation: 'vm-1',
    observedAt: now,
    snapshot: { incarnation: 'vm-1', observedAt: now.toISOString(), addresses: [{ ip: '8.8.8.8', direct: true }] },
  };
  const resources = [resource];
  const bindings: unknown[] = [];
  const writeBinding = vi.fn((value: unknown) => bindings.push(value));
  const select = () => ({
    from: (table: unknown) => {
      const rows = () =>
        table === integrationConnectors
          ? currentConnector
            ? [currentConnector]
            : []
          : table === nodes
            ? [node]
            : table === hostingResources
              ? resources
              : bindings;
      return Object.assign(Promise.resolve(rows()), {
        where: () =>
          Object.assign(Promise.resolve(rows()), {
            for: async () => rows().slice(0, 1),
            limit: async () => [], // no pre-existing managed-host conflict in this fixture
          }),
      });
    },
  });
  const db = {
    select,
    execute: vi.fn(async () => {}),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        onConflictDoNothing: async () => {
          expect(table).toBe(hostingNodeBindings);
          writeBinding(value);
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      await beforeCommit();
      return callback(db);
    },
  };
  let beforeCommit: () => void | Promise<void> = () => {};
  const connectors = {
    settings: (row: typeof connector) => row.settings,
    owner: vi.fn(async () => actor),
  };
  const inventory = new HostingInventoryService(
    db as never,
    connectors as never,
    { readFile: async () => Buffer.from('aa:bb:cc:dd:ee:ff') } as never,
    { isNodeConnected: () => true },
    { log: vi.fn() } as never
  );
  const adopt = () =>
    (inventory as unknown as { adopt: (row: unknown, adapter: unknown) => Promise<void> }).adopt(connector, {});
  return {
    adopt,
    connector,
    resource,
    resources,
    actor,
    connectors,
    writeBinding,
    current: () => currentConnector!,
    removeConnector: () => {
      currentConnector = null;
    },
    beforeCommit: (change: () => void | Promise<void>) => {
      beforeCommit = change;
    },
  };
}

describe('adoption admission and commit guards', () => {
  it.each([
    { ids: [] },
    { ids: ['allowed-100'] },
  ])('adopts unambiguously matched allowed resources with scope $ids', async ({ ids }) => {
    const test = fixture(ids);
    await test.adopt();
    expect(test.writeBinding).toHaveBeenCalledOnce();
  });
  it('does not adopt outside the saved resource allowlist', async () => {
    const test = fixture(['another-vm']);
    await test.adopt();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('still uses out-of-scope inventory to reject ambiguous matches', async () => {
    const test = fixture(['allowed-100']);
    test.resources.push({ ...test.resource, id: 'competing', remoteId: 'outside-999' });
    await test.adopt();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it.each([
    'disabled',
    'adoption_off',
    'revision',
    'resource_scope',
    'node_scope',
    'removed',
  ] as const)('does not bind after connector change during scan: %s', async (change) => {
    const test = fixture();
    test.beforeCommit(() => {
      if (change === 'disabled') test.current().enabled = false;
      if (change === 'adoption_off') test.current().settings.adoptionEnabled = false;
      if (change === 'revision') test.current().updatedAt = new Date(Date.now() + 1000);
      if (change === 'resource_scope') test.current().settings.resourceIds = ['another-vm'];
      if (change === 'node_scope') test.current().settings.adoptionNodeIds = ['another-node'];
      if (change === 'removed') test.removeConnector();
    });
    await test.adopt();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('rechecks node permissions after gathering evidence', async () => {
    const test = fixture();
    test.beforeCommit(() => {
      test.actor.scopes = ['nodes:details'];
    });
    await test.adopt();
    expect(test.connectors.owner).toHaveBeenCalledTimes(2);
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('does not bind when owner authority is revoked before commit', async () => {
    const test = fixture();
    test.beforeCommit(() => {
      test.connectors.owner.mockRejectedValue(new AppError(403, 'HOSTING_AUTOMATION_ACCESS_REVOKED', 'Revoked'));
    });
    await expect(test.adopt()).rejects.toThrow('Revoked');
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
});
