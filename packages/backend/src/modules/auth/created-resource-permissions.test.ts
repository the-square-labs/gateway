import 'reflect-metadata';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

function setup(enabled: boolean) {
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
    query: {
      permissionGroups: {
        findMany: vi.fn(async () => [{ id: 'g1', parentId: null, name: 'Creators', scopes: ['pages:create'] }]),
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
  it('does not write permissions when the setting is disabled', async () => {
    const { service, db, publish } = setup(false);
    await service.grantCreatedResourcePermissions('creator', 'pages', 'p1');
    expect(db.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
