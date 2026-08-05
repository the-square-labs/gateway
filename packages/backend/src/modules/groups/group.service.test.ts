import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { GroupService } from './group.service.js';

function createService(groups: Array<{ id: string; parentId: string | null; name: string; scopes: string[] }>) {
  return new GroupService({
    query: {
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue(groups),
      },
    },
  } as unknown as DrizzleClient);
}

describe('GroupService delete authorization', () => {
  it('rejects custom groups that would inherit admin:system from a parent', async () => {
    const service = createService([
      { id: 'system-admin', parentId: null, name: 'system-admin', scopes: ['admin:system', 'nodes:details'] },
    ]);

    await expect(
      service.assertCanCreateGroup(
        { name: 'custom-system-child', scopes: ['nodes:details'], parentId: 'system-admin' },
        ['admin:system', 'nodes:details']
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('rejects deleting a group whose scopes exceed the actor', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details', 'admin:users'] },
    ]);

    await expect(service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('checks child groups because deletion unparents and cascades permissions', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'child', scopes: ['admin:users'] },
    ]);

    await expect(service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('allows deleting a group tree fully covered by actor scopes', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'child', scopes: ['proxy:view:host-1'] },
    ]);

    await expect(
      service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details', 'proxy:view:host-1'])
    ).resolves.toBeUndefined();
  });
});

describe('GroupService MFA enforcement events', () => {
  it('notifies only local users without an MFA factor when MFA becomes required', async () => {
    const group = {
      id: 'operators',
      name: 'Operators',
      description: null,
      isBuiltin: false,
      parentId: null,
      scopes: [],
      requireGateway2fa: false,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    };
    const updated = { ...group, requireGateway2fa: true, updatedAt: new Date('2026-08-05T01:00:00.000Z') };
    const db = {
      query: { permissionGroups: { findFirst: vi.fn().mockResolvedValue(group) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })),
        })),
      })),
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              { id: 'member-needs-mfa', authMethod: 'password' },
              { id: 'member-has-totp', authMethod: 'email_otp' },
              { id: 'member-has-passkey', authMethod: 'password' },
              { id: 'member-oidc', authMethod: 'oidc' },
            ]),
          })),
        }))
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ userId: 'member-has-totp' }]) })),
        }))
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ userId: 'member-has-passkey' }]) })),
        })),
    };
    const service = new GroupService(db as unknown as DrizzleClient);
    const publish = vi.fn();
    service.setEventBus({ publish } as never);

    await service.updateGroup('operators', { requireGateway2fa: true });

    expect(publish).toHaveBeenCalledWith('mfa.required.member-needs-mfa', {
      groupId: 'operators',
      groupName: 'Operators',
      requireGateway2fa: true,
    });
    expect(publish).not.toHaveBeenCalledWith('mfa.required.member-has-totp', expect.anything());
    expect(publish).not.toHaveBeenCalledWith('mfa.required.member-has-passkey', expect.anything());
    expect(publish).not.toHaveBeenCalledWith('mfa.required.member-oidc', expect.anything());
    expect(publish).toHaveBeenCalledWith('group.mfa.required', {
      groupId: 'operators',
      groupName: 'Operators',
      requireGateway2fa: true,
      memberCount: 4,
    });
  });
});
