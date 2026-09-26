import { describe, expect, it, vi } from 'vitest';
import { CreateAccessListSchema, UpdateAccessListSchema } from './access-list.schemas.js';
import { AccessListService } from './access-list.service.js';

vi.mock('@/db/schema/index.js', () => ({
  accessLists: { id: 'access_lists.id' },
  pageProjects: { name: 'page_projects.name', accessListId: 'page_projects.access_list_id' },
}));
vi.mock('@/db/schema/proxy-hosts.js', () => ({
  proxyHosts: {
    accessListId: 'proxy_hosts.access_list_id',
    enabled: 'proxy_hosts.enabled',
    nodeId: 'proxy_hosts.node_id',
  },
}));

function makeService(deployHtpasswd: ReturnType<typeof vi.fn>) {
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ nodeId: 'nginx-node' }]),
      }),
    }),
  } as any;

  return new AccessListService(db, {} as any, {} as any, {} as any, { deployHtpasswd } as any, {} as any);
}

describe('AccessListService htpasswd deployment', () => {
  it('fails the operation when the daemon rejects credential deployment', async () => {
    const service = makeService(vi.fn().mockResolvedValue({ success: false, error: 'daemon busy' }));

    await expect(
      (service as any).writeHtpasswd('access-list-1', [{ username: 'pd', passwordHash: 'bcrypt-hash' }])
    ).rejects.toMatchObject({ statusCode: 502, code: 'HTPASSWD_DEPLOY_FAILED', message: 'daemon busy' });
  });

  it('writes the expected credential payload to every assigned node', async () => {
    const deployHtpasswd = vi.fn().mockResolvedValue({ success: true });
    const service = makeService(deployHtpasswd);

    await (service as any).writeHtpasswd('access-list-1', [{ username: 'pd', passwordHash: 'bcrypt-hash' }]);

    expect(deployHtpasswd).toHaveBeenCalledWith('nginx-node', 'access-list-1', 'pd:bcrypt-hash\n');
  });
});

describe('AccessListService update', () => {
  const existingList = {
    id: 'access-list-1',
    name: 'office',
    description: 'Office only',
    ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
    basicAuthEnabled: false,
    basicAuthUsers: [],
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const hosts = [
    { id: 'host-1', domainNames: ['one.example.com'], nodeId: 'node-1' },
    { id: 'host-2', domainNames: ['two.example.com'], nodeId: 'node-2' },
  ];

  function makeUpdateService(
    reapplyHostConfig: ReturnType<typeof vi.fn>,
    nodeState: { offline?: string[]; updating?: string[] } = {}
  ) {
    const writes: Record<string, unknown>[] = [];
    const db = {
      query: {
        accessLists: { findFirst: vi.fn().mockResolvedValue(existingList) },
        proxyHosts: { findMany: vi.fn().mockResolvedValue(hosts) },
        pageProjects: { findMany: vi.fn().mockResolvedValue([]) },
      },
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: () => {
              const result = Promise.resolve(undefined) as Promise<undefined> & { returning: () => unknown };
              result.returning = async () => [{ ...existingList, ...values }];
              return result;
            },
          };
        },
      })),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ nodeId: 'nginx-node' }]) }),
      }),
    } as any;
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const nodeDispatch = {
      removeHtpasswd: vi.fn().mockResolvedValue({ success: true }),
      isNodeConnected: vi.fn((nodeId: string) => !nodeState.offline?.includes(nodeId)),
      isNodeUpdateInProgress: vi.fn(async (nodeId: string) => !!nodeState.updating?.includes(nodeId)),
    };
    const service = new AccessListService(db, {} as any, {} as any, audit as any, nodeDispatch as any, {} as any);
    service.setHostRuntime({ reapplyHostConfig: reapplyHostConfig as (hostId: string) => Promise<unknown> });
    return { service, writes, audit };
  }

  it('re-applies every enabled host through the proxy build/apply path', async () => {
    const reapplyHostConfig = vi.fn().mockResolvedValue(undefined);
    const { service, writes } = makeUpdateService(reapplyHostConfig);

    await service.update('access-list-1', { ipRules: [{ type: 'deny', value: 'all' }] }, 'user-1');

    expect(writes[0]).toMatchObject({ ipRules: [{ type: 'deny', value: 'all' }] });
    expect(reapplyHostConfig.mock.calls.map(([id]) => id)).toEqual(['host-1', 'host-2']);
  });

  it('rolls back the list and re-applies the previous rules when a host fails', async () => {
    const reapplyHostConfig = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('nginx: [emerg] invalid directive'))
      .mockResolvedValue(undefined);
    const { service, writes, audit } = makeUpdateService(reapplyHostConfig);

    await expect(
      service.update('access-list-1', { ipRules: [{ type: 'deny', value: 'all' }] }, 'user-1')
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'ACCESS_LIST_APPLY_FAILED',
      message: expect.stringContaining('two.example.com'),
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      ipRules: existingList.ipRules,
      basicAuthEnabled: false,
      description: 'Office only',
      updatedAt: existingList.updatedAt,
    });
    // Both hosts are restored after the rollback, including the one already changed.
    expect(reapplyHostConfig.mock.calls.map(([id]) => id)).toEqual(['host-1', 'host-2', 'host-1', 'host-2']);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('skips hosts on offline or updating nodes instead of rolling back', async () => {
    const reapplyHostConfig = vi.fn().mockResolvedValue(undefined);
    const { service, writes, audit } = makeUpdateService(reapplyHostConfig, { offline: ['node-1'] });

    await service.update('access-list-1', { ipRules: [{ type: 'deny', value: 'all' }] }, 'user-1');
    expect(reapplyHostConfig.mock.calls.map(([id]) => id)).toEqual(['host-2']);
    expect(writes).toHaveLength(1);
    expect(audit.log).toHaveBeenCalled();

    const updating = makeUpdateService(vi.fn().mockResolvedValue(undefined), { updating: ['node-2'] });
    await updating.service.update('access-list-1', { ipRules: [{ type: 'deny', value: 'all' }] }, 'user-1');
    expect(updating.writes).toHaveLength(1);
  });

  it('does not roll back when the node drops mid-apply', async () => {
    const nodeState: { offline: string[] } = { offline: [] };
    const reapplyHostConfig = vi.fn(async (hostId: string) => {
      if (hostId === 'host-2') {
        nodeState.offline.push('node-2');
        throw new Error('Node node-2 is not connected');
      }
    });
    const { service, writes } = makeUpdateService(reapplyHostConfig, nodeState);

    await service.update('access-list-1', { ipRules: [{ type: 'deny', value: 'all' }] }, 'user-1');
    expect(writes).toHaveLength(1);
    expect(reapplyHostConfig).toHaveBeenCalledTimes(2);
  });

  it('rejects enabling basic auth without users before touching the database or nodes', async () => {
    const reapplyHostConfig = vi.fn();
    const { service, writes } = makeUpdateService(reapplyHostConfig);

    await expect(service.update('access-list-1', { basicAuthEnabled: true }, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BASIC_AUTH_USERS_REQUIRED',
    });
    expect(writes).toHaveLength(0);
    expect(reapplyHostConfig).not.toHaveBeenCalled();
  });

  it('clears the description', async () => {
    const { service, writes } = makeUpdateService(vi.fn().mockResolvedValue(undefined));

    await service.update('access-list-1', { description: '' }, 'user-1');

    expect(writes[0]).toMatchObject({ description: null });
  });
});

describe('AccessListService delete', () => {
  it('refuses a list that protects Pages previews before touching its credentials', async () => {
    const deleted = vi.fn();
    const removeHtpasswd = vi.fn();
    const db = {
      query: {
        accessLists: { findFirst: vi.fn().mockResolvedValue({ id: 'access-list-1', name: 'office' }) },
        proxyHosts: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: vi.fn(() => ({
        from: () => ({ where: vi.fn().mockResolvedValue([{ name: 'Quarterly report' }]) }),
      })),
      delete: deleted,
    } as any;
    const service = new AccessListService(db, {} as any, {} as any, {} as any, {} as any, {} as any);
    (service as any).removeHtpasswd = removeHtpasswd;

    await expect(service.delete('access-list-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACCESS_LIST_IN_USE',
      details: { pageProjects: ['Quarterly report'] },
    });
    expect(removeHtpasswd).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });
});

describe('access list schemas', () => {
  it.each(['10.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '::1', '2001:db8::/32', 'fe80::1', 'all'])('accepts %s', (value) => {
    expect(UpdateAccessListSchema.safeParse({ ipRules: [{ type: 'allow', value }] }).success).toBe(true);
  });

  it.each([
    '10.0.0.0/99',
    '999.1.1.1',
    'cafe',
    '10.0.0.1/',
    '::1/129',
    '10.0.0.0/-1',
    'fe80::1%eth0',
    'ALL',
  ])('rejects %s', (value) => {
    expect(UpdateAccessListSchema.safeParse({ ipRules: [{ type: 'allow', value }] }).success).toBe(false);
  });

  it('rejects basic auth without users and htpasswd-breaking usernames on create', () => {
    expect(CreateAccessListSchema.safeParse({ name: 'x', basicAuthEnabled: true }).success).toBe(false);
    expect(
      CreateAccessListSchema.safeParse({
        name: 'x',
        basicAuthEnabled: true,
        basicAuthUsers: [{ username: 'a:b', password: 'secret' }],
      }).success
    ).toBe(false);
    expect(
      CreateAccessListSchema.safeParse({
        name: 'x',
        basicAuthEnabled: true,
        basicAuthUsers: [{ username: 'alice', password: 'secret' }],
      }).success
    ).toBe(true);
  });
});

describe('AccessListService htpasswd removal', () => {
  it('keeps the credentials on nodes where a Pages Project still protects its previews with the list', async () => {
    const removeHtpasswd = vi.fn().mockResolvedValue({ success: true });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ nodeId: 'proxy-node' }, { nodeId: 'pages-node' }, { nodeId: null }]),
        }),
      }),
      query: {
        pageProjects: {
          findMany: vi.fn().mockResolvedValue([
            { nodeId: 'pages-node', migrationTargetNodeId: null },
            { nodeId: 'other-node', migrationTargetNodeId: 'target-node' },
          ]),
        },
      },
    } as any;
    const service = new AccessListService(db, {} as any, {} as any, {} as any, { removeHtpasswd } as any, {} as any);

    await (service as any).removeHtpasswd('access-list-1');

    expect(removeHtpasswd.mock.calls).toEqual([['proxy-node', 'access-list-1']]);
  });
});
