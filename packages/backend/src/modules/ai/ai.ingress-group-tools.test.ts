import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  groups: {
    list: vi.fn(),
    requireGroup: vi.fn(),
    get: vi.fn(),
    getSummary: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    reorder: vi.fn(),
    convertRoute: vi.fn(),
    convertDomain: vi.fn(),
    memberNodeIds: vi.fn(),
  },
  license: { requireFeature: vi.fn() },
  proxy: { getProxyHost: vi.fn() },
  domains: { getDomain: vi.fn() },
}));

vi.mock('@/modules/ingress-groups/ingress-group.service.js', () => ({
  IngressGroupService: class IngressGroupService {},
}));
vi.mock('@/modules/license/license-policy.service.js', () => ({
  LicensePolicyService: class LicensePolicyService {},
}));
vi.mock('@/modules/proxy/proxy.service.js', () => ({ ProxyService: class ProxyService {} }));
vi.mock('@/modules/domains/domain.service.js', () => ({ DomainsService: class DomainsService {} }));
vi.mock('@/container.js', () => ({
  container: {
    resolve: (token: { name: string }) =>
      ({
        IngressGroupService: mocks.groups,
        LicensePolicyService: mocks.license,
        ProxyService: mocks.proxy,
        DomainsService: mocks.domains,
      })[token.name],
  },
}));

import { executeIngressGroupTool } from './ai.ingress-group-tools.js';

const GROUP = '11111111-1111-4111-8111-111111111111';
const NODE_A = '22222222-2222-4222-8222-222222222222';
const NODE_B = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const ROUTE = '55555555-5555-4555-8555-555555555555';

const call = (scopes: string[], args: Record<string, unknown>) =>
  executeIngressGroupTool({ id: 'user-1', scopes } as never, args);

describe('manage_ingress_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.groups.list.mockResolvedValue([
      { id: 'root-group', folderId: null },
      { id: 'folder-group', folderId: FOLDER },
    ]);
    mocks.groups.requireGroup.mockResolvedValue({ id: GROUP, folderId: FOLDER });
    mocks.groups.getSummary.mockResolvedValue({
      id: GROUP,
      folderId: FOLDER,
      members: [{ nodeId: NODE_A }, { nodeId: NODE_B }],
    });
    mocks.groups.create.mockResolvedValue({ id: GROUP });
    mocks.groups.removeMember.mockResolvedValue({ id: GROUP });
    mocks.groups.convertRoute.mockResolvedValue({ id: ROUTE, nodeId: NODE_A, ingressGroupId: GROUP, domainNames: [] });
    mocks.license.requireFeature.mockResolvedValue(undefined);
    mocks.proxy.getProxyHost.mockResolvedValue({ id: ROUTE, folderId: null });
  });

  it('lists every group for node viewers and only folder groups for folder-limited callers', async () => {
    await expect(call(['nodes:details'], { operation: 'list' })).resolves.toEqual({
      data: [
        { id: 'root-group', folderId: null },
        { id: 'folder-group', folderId: FOLDER },
      ],
    });
    await expect(call([`nodes:details:folder/${FOLDER}`], { operation: 'list' })).resolves.toEqual({
      data: [{ id: 'folder-group', folderId: FOLDER }],
    });
    await expect(call(['proxy:view'], { operation: 'list' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('creates a group only with nodes:manage on every member and the multi-node entitlement', async () => {
    const create = { operation: 'create', name: 'Edge', nodeIds: [NODE_A, NODE_B], folderId: FOLDER };

    await expect(call([`nodes:manage:folder/${FOLDER}`, `nodes:manage:${NODE_A}`], create)).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredScope: `nodes:manage:${NODE_B}` },
    });
    expect(mocks.groups.create).not.toHaveBeenCalled();

    await expect(call(['nodes:manage'], { ...create, unrelated: true })).resolves.toEqual({ id: GROUP });
    expect(mocks.license.requireFeature).toHaveBeenCalledWith('multi-node-availability');
    expect(mocks.groups.create).toHaveBeenCalledWith(
      { name: 'Edge', nodeIds: [NODE_A, NODE_B], folderId: FOLDER },
      'user-1'
    );
  });

  it('refuses growing a group without the entitlement but always allows removing a member', async () => {
    mocks.license.requireFeature.mockRejectedValue(Object.assign(new Error('license'), { statusCode: 402 }));

    await expect(
      call(['nodes:manage'], { operation: 'add_member', groupId: GROUP, nodeId: NODE_A })
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(mocks.groups.addMember).not.toHaveBeenCalled();

    await expect(
      call(['nodes:manage'], { operation: 'remove_member', groupId: GROUP, nodeId: NODE_A, force: true })
    ).resolves.toEqual({ id: GROUP });
    expect(mocks.groups.removeMember).toHaveBeenCalledWith(GROUP, NODE_A, { force: true }, 'user-1');
  });

  it('converts a route only with proxy:edit on it and proxy:create covering every member', async () => {
    const convert = { operation: 'convert_route', groupId: GROUP, proxyHostId: ROUTE };

    await expect(call([`proxy:create:node/${NODE_A}`], convert)).rejects.toMatchObject({ statusCode: 403 });
    await expect(call([`proxy:edit:${ROUTE}`, `proxy:create:node/${NODE_A}`], convert)).rejects.toMatchObject({
      statusCode: 403,
      details: { nodeIds: [NODE_B] },
    });
    expect(mocks.groups.convertRoute).not.toHaveBeenCalled();

    await expect(
      call([`proxy:edit:${ROUTE}`, `proxy:create:node/${NODE_A}`, `proxy:create:node/${NODE_B}`], convert)
    ).resolves.toMatchObject({ id: ROUTE, ingressGroupId: GROUP });
    expect(mocks.groups.convertRoute).toHaveBeenCalledWith(ROUTE, { ingressGroupId: GROUP }, 'user-1');
  });

  it('requires the ids an operation works on', async () => {
    await expect(call(['nodes:manage'], { operation: 'get' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call(['nodes:manage'], { operation: 'remove_member', groupId: GROUP })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(call(['nodes:manage'], { operation: 'rename' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
