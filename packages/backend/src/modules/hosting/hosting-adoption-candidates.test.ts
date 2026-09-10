import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingResources, nodes } from '@/db/schema/index.js';
import type { User } from '@/types.js';
import { HostingSettingsSchema } from './hosting.schemas.js';
import { HostingInventoryService } from './hosting-inventory.service.js';

function fixture() {
  const settings = HostingSettingsSchema.parse({ resourceIds: ['100', '101', '102', '103'] });
  const user = {
    id: 'actor',
    scopes: [
      'integrations:hosting:manage',
      'integrations:hosting:view',
      'nodes:details:node',
      'nodes:config:edit:node',
    ],
  } as User;
  const connector = { id: 'connector', enabled: true, settings };
  const make = (id: string, remoteId: string, extra = {}) => ({
    id,
    remoteId,
    kind: 'ct',
    origin: 'discovered',
    managedHostIdentity: null,
    snapshot: { name: id, location: 'pve' },
    ...extra,
  });
  const resources = [
    make('free', '100'),
    make('bound', '101'),
    make('managed', '102', { managedHostIdentity: 'host' }),
    make('created', '103', { origin: 'created' }),
    make('out-of-scope', '104'),
  ];
  const nodeRows = [
    { id: 'node', hostname: 'legacy', displayName: 'Legacy', type: 'docker', status: 'online', hostIdentityId: null },
    { id: 'hidden', hostname: 'secret' },
    { id: 'bound-node', hostname: 'bound' },
  ];
  const bindings = [{ nodeId: 'bound-node', resourceId: 'bound' }];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === hostingResources
            ? resources
            : table === nodes
              ? nodeRows
              : table === hostingNodeBindings
                ? bindings
                : [];
        return Object.assign(Promise.resolve(rows), { where: () => Promise.resolve(rows) });
      },
    }),
  };
  const connectors = { get: vi.fn(async () => connector), owner: vi.fn(async () => user), settings: () => settings };
  const service = new HostingInventoryService(db as never, connectors as never, {} as never, {} as never, {} as never);
  return { service, user, settings, connectors };
}

describe('adoption candidates and selected admission', () => {
  it('lists only allowed unbound discovered resources and accessible unbound nodes, including legacy nodes', async () => {
    const t = fixture();
    const result = await t.service.adoptionCandidates('connector', t.user);
    expect(result.resources.map((r) => r.id)).toEqual(['free']);
    expect(result.nodes.map((n) => n.id)).toEqual(['node']);
  });
  it('enforces configured node allowlist and manage authority', async () => {
    const t = fixture();
    t.settings.adoptionNodeIds = ['another'];
    expect((await t.service.adoptionCandidates('connector', t.user)).nodes).toEqual([]);
    await expect(t.service.adoptionCandidates('connector', { ...t.user, scopes: [] })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('rejects unavailable selections before any provider refresh', async () => {
    const t = fixture();
    const sync = vi.spyOn(t.service, 'sync');
    await expect(
      t.service.adoptNode('connector', { resourceId: 'bound', nodeId: 'node' }, t.user)
    ).rejects.toMatchObject({ code: 'HOSTING_ADOPTION_UNAVAILABLE' });
    expect(sync).not.toHaveBeenCalled();
  });
  it('does not verify against inventory owned by an in-flight sync', async () => {
    const t = fixture();
    const sync = vi.spyOn(t.service, 'sync').mockResolvedValue({ skipped: true, reason: 'sync_running' });
    await expect(
      t.service.adoptNode('connector', { resourceId: 'free', nodeId: 'node' }, t.user)
    ).rejects.toMatchObject({ code: 'HOSTING_ADOPTION_BUSY' });
    expect(sync).toHaveBeenCalledWith('connector', t.user, false, true);
  });
});
