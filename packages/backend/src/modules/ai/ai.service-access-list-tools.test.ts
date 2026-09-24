import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(accessListService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    accessListService as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('AIService access-list tool routing', () => {
  it('routes access-list list/create/delete operations through the access-list service', async () => {
    const accessListService = {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'acl-1' }], total: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'acl-2', name: 'Office' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(accessListService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:view'] }, 'list_access_lists', {
        search: 'office',
        page: 2,
        limit: 25,
      })
    ).resolves.toEqual({ result: { data: [{ id: 'acl-1' }], total: 1 }, invalidateStores: [] });
    expect(accessListService.list).toHaveBeenCalledWith(
      { search: 'office', page: 2, limit: 25 },
      { allowedIds: undefined }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:create'] }, 'create_access_list', {
        name: 'Office',
        allowIps: ['10.0.0.0/8'],
        denyIps: ['192.0.2.10'],
        basicAuthUsers: [{ username: 'admin', password: 'secret' }],
      })
    ).resolves.toEqual({ result: { id: 'acl-2', name: 'Office' }, invalidateStores: ['accessLists'] });
    expect(accessListService.create).toHaveBeenCalledWith(
      {
        name: 'Office',
        ipRules: [
          { value: '10.0.0.0/8', type: 'allow' },
          { value: '192.0.2.10', type: 'deny' },
        ],
        basicAuthEnabled: true,
        basicAuthUsers: [{ username: 'admin', password: 'secret' }],
      },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:delete:acl-1'] }, 'delete_access_list', {
        accessListId: 'acl-1',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['accessLists'] });
    expect(accessListService.delete).toHaveBeenCalledWith('acl-1', 'user-1');
  });

  it('routes managed access-list get/update operations with resource scopes', async () => {
    const accessListService = {
      get: vi.fn().mockResolvedValue({ id: 'acl-1', name: 'old' }),
      update: vi.fn().mockResolvedValue({ id: 'acl-1', name: 'new' }),
    };
    const service = createService(accessListService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:view', 'acl:view:acl-1'] }, 'manage_access_list', {
        operation: 'get',
        accessListId: 'acl-1',
      })
    ).resolves.toEqual({ result: { id: 'acl-1', name: 'old' }, invalidateStores: ['accessLists'] });
    expect(accessListService.get).toHaveBeenCalledWith('acl-1');

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['acl:view', 'acl:view:acl-1', 'acl:edit:acl-1'] },
        'manage_access_list',
        {
          operation: 'update',
          accessListId: 'acl-1',
          name: 'new',
          description: null,
          ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
          basicAuthEnabled: false,
          basicAuthUsers: [],
        }
      )
    ).resolves.toEqual({ result: { id: 'acl-1', name: 'new' }, invalidateStores: ['accessLists'] });
    expect(accessListService.update).toHaveBeenCalledWith(
      'acl-1',
      {
        name: 'new',
        description: null,
        ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
        basicAuthEnabled: false,
        basicAuthUsers: [],
      },
      'user-1'
    );
  });

  it('creates access lists with the route schema, including description and ordered rules', async () => {
    const accessListService = { create: vi.fn().mockResolvedValue({ id: 'acl-3' }) };
    const service = createService(accessListService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:create'] }, 'create_access_list', {
        name: 'Bad',
        allowIps: ['not-an-ip'],
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('valid IP address') });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['acl:create'] }, 'create_access_list', {
        name: 'Auth only',
        basicAuthEnabled: true,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Add at least one user') });
    expect(accessListService.create).not.toHaveBeenCalled();

    await service.executeTool({ ...BASE_USER, scopes: ['acl:create'] }, 'create_access_list', {
      name: 'Office',
      description: 'HQ only',
      ipRules: [{ type: 'deny', value: '10.0.0.5' }],
      allowIps: ['10.0.0.0/8'],
    });
    expect(accessListService.create).toHaveBeenCalledWith(
      {
        name: 'Office',
        description: 'HQ only',
        ipRules: [
          { type: 'deny', value: '10.0.0.5' },
          { type: 'allow', value: '10.0.0.0/8' },
        ],
        basicAuthEnabled: false,
        basicAuthUsers: [],
      },
      'user-1'
    );
  });
});
