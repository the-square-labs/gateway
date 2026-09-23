import { describe, expect, it, vi } from 'vitest';
import { CreateAccessListSchema, UpdateAccessListSchema } from './access-list.schemas.js';
import { AccessListService } from './access-list.service.js';

vi.mock('@/db/schema/index.js', () => ({ accessLists: { id: 'access_lists.id' } }));
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
    { id: 'host-1', domainNames: ['one.example.com'] },
    { id: 'host-2', domainNames: ['two.example.com'] },
  ];

  function makeUpdateService(reapplyHostConfig: ReturnType<typeof vi.fn>) {
    const writes: Record<string, unknown>[] = [];
    const db = {
      query: {
        accessLists: { findFirst: vi.fn().mockResolvedValue(existingList) },
        proxyHosts: { findMany: vi.fn().mockResolvedValue(hosts) },
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
    const nodeDispatch = { removeHtpasswd: vi.fn().mockResolvedValue({ success: true }) };
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
      .mockRejectedValueOnce(new Error('Node nginx-node is not connected'))
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
