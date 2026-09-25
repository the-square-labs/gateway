import 'reflect-metadata';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

function setup(enabled: boolean, groupScopes: string[] = ['pages:create', 'pages:edit']) {
  let additionalScopes = ['nodes:details:n1'];
  const user = {
    id: 'creator',
    groupId: 'g1',
    additionalGroupIds: [],
    name: 'Creator',
    email: 'creator@example.com',
    isBlocked: false,
    deletedAt: null,
  };
  const statements: { sql: string; params: unknown[] }[] = [];
  const set = vi.fn((values) => {
    if (Array.isArray(values.additionalScopes)) additionalScopes = values.additionalScopes;
    else {
      const query = new PgDialect().sqlToQuery(values.additionalScopes);
      statements.push(query);
      additionalScopes = [...new Set([...additionalScopes, ...JSON.parse(String(query.params[0]))])];
    }
    return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...user, additionalScopes }]) })) };
  });
  const db = {
    update: vi.fn(() => ({ set })),
    // Folder expansion: one Page Project folder holding the new project p1.
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: () =>
        'parentId' in fields
          ? Promise.resolve([{ id: '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e', parentId: null }])
          : { where: async () => [{ id: 'p1', folderId: '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e' }] },
    })),
    query: {
      users: { findFirst: vi.fn(async () => ({ ...user, additionalScopes })) },
      permissionGroups: {
        findMany: vi.fn(async () => [{ id: 'g1', parentId: null, name: 'Creators', scopes: groupScopes }]),
      },
    },
  };
  const service = new AuthService(db as never, {} as never, {} as never, {} as never, {} as never, undefined, {
    getConfig: vi.fn(async () => ({ autoAssignCreatedResourcePermissions: enabled })),
  } as never);
  const publish = vi.fn();
  service.setEventBus({ publish } as never);
  return { service, db, statements, publish, saved: () => additionalScopes };
}

describe('creator grants are ordinary additional permissions', () => {
  it('atomically appends concrete permissions, preserves existing grants, and notifies live clients', async () => {
    const { service, statements, publish, saved } = setup(true);
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p1');
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p2');
    expect(saved()).toEqual(expect.arrayContaining(['nodes:details:n1', 'pages:view:p1', 'pages:edit:p2']));
    // Only what the creator holds: no delete, deploy-token, or tag management.
    expect(
      saved()
        .filter((scope) => scope.startsWith('pages:') && scope.endsWith(':p1'))
        .sort()
    ).toEqual(['pages:edit:p1', 'pages:view:p1']);
    expect(statements[0].sql).toContain('jsonb_array_elements("users"."additional_scopes" ||');
    expect(publish).toHaveBeenCalledWith(
      'permissions.changed.creator',
      expect.objectContaining({
        reason: 'resource_created',
        scopes: expect.arrayContaining(['pages:view:p1', 'pages:create']),
      })
    );
    await service.updateUserAdditionalScopes('creator', []);
    expect(saved()).toEqual([]);
  });
  it('limits the grant to scopes the creator holds on the destination folder', async () => {
    const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const { service, saved } = setup(true, [`pages:create:folder/${folderId}`, `pages:deploy:folder/${folderId}`]);
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p1', { folderId });
    expect(
      saved()
        .filter((scope) => scope.endsWith(':p1'))
        .sort()
    ).toEqual(['pages:deploy:p1', 'pages:view:p1']);
  });

  it('always grants the creator view of the new resource, even with only a creation scope', async () => {
    const { service, saved } = setup(true, ['domains:create:node/node-1']);
    await service.grantCreatedResourcePermissions('creator', 'domains', 'd1');
    expect(saved().filter((scope) => scope.endsWith(':d1'))).toEqual(['domains:view:d1']);
  });

  it('reads the destination from the created row when the caller passes none', async () => {
    const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const { service, db, saved } = setup(true, [`pages:create:folder/${folderId}`, `pages:deploy:folder/${folderId}`]);
    // The new project is not visible to folder expansion yet, so only the stored destination can match.
    (db.select as ReturnType<typeof vi.fn>).mockImplementation((fields: Record<string, unknown>) => ({
      from: () =>
        'parentId' in fields
          ? Promise.resolve([{ id: folderId, parentId: null }])
          : 'nodeId' in fields
            ? { where: () => ({ limit: async () => [{ folderId, nodeId: null }] }) }
            : { where: async () => [] },
    }));
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p1');
    expect(
      saved()
        .filter((scope) => scope.endsWith(':p1'))
        .sort()
    ).toEqual(['pages:deploy:p1', 'pages:view:p1']);
  });

  it('does not write permissions when the setting is disabled', async () => {
    const { service, db, publish } = setup(false);
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p1');
    expect(db.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
