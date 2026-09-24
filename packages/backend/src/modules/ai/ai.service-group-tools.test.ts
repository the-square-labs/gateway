import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['admin:groups'] as string[],
  isBlocked: false,
};

function createService(
  groupService: Record<string, unknown>,
  auditService: Record<string, unknown> = { log: vi.fn() }
) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    auditService as never,
    {} as never,
    {} as never,
    groupService as never,
    {} as never,
    {} as never
  );
}

describe('AIService group tool routing', () => {
  it('routes permission group list/create/update/delete like the group routes, with audit', async () => {
    const groupService = {
      listGroups: vi.fn().mockResolvedValue([{ id: 'group-1', name: 'Admin' }]),
      assertCanCreateGroup: vi.fn().mockResolvedValue(undefined),
      createGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, name: 'operators' }),
      assertCanUpdateGroup: vi.fn().mockResolvedValue(undefined),
      updateGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, name: 'ops' }),
      assertCanDeleteGroup: vi.fn().mockResolvedValue(undefined),
      getGroup: vi.fn().mockResolvedValue({ id: GROUP_ID, name: 'ops' }),
      deleteGroup: vi.fn().mockResolvedValue(undefined),
    };
    const auditService = { log: vi.fn() };
    const service = createService(groupService, auditService);

    await expect(service.executeTool(BASE_USER, 'list_groups', {})).resolves.toEqual({
      result: [{ id: 'group-1', name: 'Admin' }],
      invalidateStores: [],
    });
    expect(groupService.listGroups).toHaveBeenCalledWith();

    await expect(
      service.executeTool(BASE_USER, 'create_group', {
        name: 'operators',
        description: 'Ops team',
        scopes: ['proxy:view'],
        parentId: PARENT_ID,
      })
    ).resolves.toEqual({
      result: { id: GROUP_ID, name: 'operators' },
      invalidateStores: ['groups'],
    });
    const createInput = { name: 'operators', description: 'Ops team', scopes: ['proxy:view'], parentId: PARENT_ID };
    expect(groupService.assertCanCreateGroup).toHaveBeenCalledWith(createInput, BASE_USER.scopes);
    expect(groupService.createGroup).toHaveBeenCalledWith(createInput);

    const updateInput = {
      name: 'ops',
      description: 'Updated',
      scopes: ['proxy:view', 'ssl:cert:view'],
      parentId: null,
    };
    await expect(
      service.executeTool(BASE_USER, 'update_group', { groupId: GROUP_ID, ...updateInput })
    ).resolves.toEqual({
      result: { id: GROUP_ID, name: 'ops' },
      invalidateStores: ['groups'],
    });
    expect(groupService.assertCanUpdateGroup).toHaveBeenCalledWith(GROUP_ID, updateInput, BASE_USER.scopes);
    expect(groupService.updateGroup).toHaveBeenCalledWith(GROUP_ID, updateInput);

    await expect(service.executeTool(BASE_USER, 'delete_group', { groupId: GROUP_ID })).resolves.toEqual({
      result: { success: true },
      invalidateStores: ['groups'],
    });
    expect(groupService.assertCanDeleteGroup).toHaveBeenCalledWith(GROUP_ID, BASE_USER.scopes);
    expect(groupService.deleteGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(auditService.log.mock.calls.map(([entry]) => entry.action)).toEqual(
      expect.arrayContaining(['group.create', 'group.update', 'group.delete'])
    );
  });

  it('validates group names like CreateGroupSchema before touching the service', async () => {
    const groupService = { assertCanCreateGroup: vi.fn(), createGroup: vi.fn() };
    const service = createService(groupService);

    await expect(
      service.executeTool(BASE_USER, 'create_group', { name: 'Operators!', scopes: ['proxy:view'] })
    ).resolves.toMatchObject({ error: expect.stringContaining('lowercase alphanumeric') });
    expect(groupService.createGroup).not.toHaveBeenCalled();
  });

  it('applies the per-group admin:groups grant to list, update, and delete', async () => {
    const groupService = {
      listGroups: vi.fn().mockResolvedValue([
        { id: 'group-1', name: 'visible' },
        { id: 'group-9', name: 'hidden' },
      ]),
      assertCanUpdateGroup: vi.fn(),
      updateGroup: vi.fn(),
      assertCanDeleteGroup: vi.fn(),
      deleteGroup: vi.fn(),
    };
    const service = createService(groupService);
    const scopedUser = { ...BASE_USER, scopes: ['admin:groups:group-1'] };

    await expect(service.executeTool(scopedUser, 'list_groups', {})).resolves.toEqual({
      result: [{ id: 'group-1', name: 'visible' }],
      invalidateStores: [],
    });
    await expect(
      service.executeTool(scopedUser, 'update_group', { groupId: 'group-9', name: 'renamed' })
    ).resolves.toMatchObject({ error: 'Missing required scope: admin:groups:group-9' });
    await expect(service.executeTool(scopedUser, 'delete_group', { groupId: 'group-9' })).resolves.toMatchObject({
      error: 'Missing required scope: admin:groups:group-9',
    });
    expect(groupService.updateGroup).not.toHaveBeenCalled();
    expect(groupService.deleteGroup).not.toHaveBeenCalled();
  });

  it('does not delete a group when descendant-scope authorization rejects it', async () => {
    const groupService = {
      assertCanDeleteGroup: vi.fn().mockRejectedValue(new Error('Cannot delete group with broader scopes')),
      deleteGroup: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(groupService);

    await expect(service.executeTool(BASE_USER, 'delete_group', { groupId: GROUP_ID })).resolves.toEqual({
      error: 'Cannot delete group with broader scopes',
      invalidateStores: [],
    });
    expect(groupService.deleteGroup).not.toHaveBeenCalled();
  });
});
