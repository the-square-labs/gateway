import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingResources, integrationConnectors, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
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
    hostIdentityId: 'host' as string | null,
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
  const updateNode = vi.fn();
  const ensureIdentity = vi.fn(async () => ({
    success: true,
    data: Buffer.from('11111111-1111-4111-8111-111111111111'),
  }));
  const readFile = vi.fn(async (_id: string, path: string) => {
    if (path === '/var/lib/gateway/host-identity') throw new Error('missing');
    return Buffer.from('aa:bb:cc:dd:ee:ff');
  });
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
    update: (table: unknown) => ({
      set: (value: unknown) => ({
        where: async () => {
          if (table === nodes) updateNode(value);
        },
      }),
    }),
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
    assertAdoptionActor: vi.fn(async () => {}),
  };
  const inventory = new HostingInventoryService(
    db as never,
    connectors as never,
    { readFile } as never,
    { isNodeConnected: () => true, sendNodeFileCommand: ensureIdentity } as never,
    { log: vi.fn() } as never
  );
  const adopt = (selected?: { resourceId: string; nodeId: string; user: User }) =>
    (inventory as unknown as { adopt: (row: unknown, adapter: unknown, selected?: unknown) => Promise<unknown> }).adopt(
      connector,
      {},
      selected
    );
  return {
    adopt,
    node,
    readFile,
    ensureIdentity,
    updateNode,
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

const explicitActor = {
  id: 'caller',
  scopes: ['integrations:hosting:manage', 'integrations:hosting:view', 'nodes:details', 'nodes:config:edit'],
} as User;
const selected = { resourceId: 'resource', nodeId: 'node', user: explicitActor };
describe('explicit verified adoption and legacy LXC', () => {
  it('allows explicit verified selection while automatic adoption is disabled', async () => {
    const test = fixture();
    test.connector.settings.adoptionEnabled = false;
    test.current().settings.adoptionEnabled = false;
    await expect(test.adopt(selected)).resolves.toEqual({ resourceId: 'resource', nodeIds: ['node'] });
    expect(test.writeBinding).toHaveBeenCalledOnce();
  });
  it('never treats the selected pair as evidence', async () => {
    const test = fixture();
    test.resource.snapshot.addresses = [{ ip: '1.1.1.1', direct: true }];
    await expect(test.adopt(selected)).resolves.toBeUndefined();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('retains global uniqueness for explicit selection', async () => {
    const test = fixture();
    test.resources.push({ ...test.resource, id: 'duplicate' });
    await test.adopt(selected);
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('checks explicit caller permissions independently from owner', async () => {
    const test = fixture();
    await expect(
      test.adopt({
        ...selected,
        user: {
          ...explicitActor,
          scopes: ['integrations:hosting:manage', 'integrations:hosting:view', 'nodes:details'],
        },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('recovers a legacy LXC identity only after matching private IP and MAC', async () => {
    const test = fixture();
    test.node.hostIdentityId = null;
    test.node.lastHealthReport.networkInterfaces[0].ipAddresses = ['10.0.0.5'];
    Object.assign(test.resource.snapshot, {
      kind: 'ct',
      addresses: [{ ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff', direct: true }],
    });
    await test.adopt();
    expect(test.ensureIdentity).toHaveBeenCalledWith('node', 'ensure-host-identity');
    expect(test.updateNode).toHaveBeenCalledWith({ hostIdentityId: '11111111-1111-4111-8111-111111111111' });
    expect(test.writeBinding).toHaveBeenCalledWith(expect.objectContaining({ evidenceType: 'interface_match' }));
  });
  it('does not create identity for private IP alone, mismatches or ambiguous resources', async () => {
    for (const mismatch of ['missing_mac', 'wrong_mac', 'ambiguous']) {
      const test = fixture();
      test.node.hostIdentityId = null;
      test.node.lastHealthReport.networkInterfaces[0].ipAddresses = ['10.0.0.5'];
      Object.assign(test.resource.snapshot, {
        kind: 'ct',
        addresses: [
          {
            ip: '10.0.0.5',
            mac:
              mismatch === 'missing_mac'
                ? undefined
                : mismatch === 'wrong_mac'
                  ? '00:11:22:33:44:55'
                  : 'aa:bb:cc:dd:ee:ff',
            direct: true,
          },
        ],
      });
      if (mismatch === 'ambiguous') test.resources.push({ ...test.resource, id: 'duplicate' });
      await test.adopt();
      expect(test.ensureIdentity).not.toHaveBeenCalled();
      expect(test.writeBinding).not.toHaveBeenCalled();
    }
  });
  it('fails closed when a legacy daemon cannot persist identity', async () => {
    const test = fixture();
    test.node.hostIdentityId = null;
    test.ensureIdentity.mockResolvedValue({ success: false, data: Buffer.alloc(0) });
    await expect(test.adopt(selected)).rejects.toMatchObject({ code: 'HOSTING_NODE_IDENTITY_REQUIRED' });
    expect(test.updateNode).not.toHaveBeenCalled();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
  it('refuses malformed persisted identity rather than replacing it', async () => {
    const test = fixture();
    test.node.hostIdentityId = null;
    test.readFile.mockResolvedValue(Buffer.from('broken'));
    await test.adopt();
    expect(test.ensureIdentity).not.toHaveBeenCalled();
    expect(test.writeBinding).not.toHaveBeenCalled();
  });
});
