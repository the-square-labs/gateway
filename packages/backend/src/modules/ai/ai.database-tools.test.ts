import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import { executeResourceSetupTool } from './ai.resource-setup-tools.js';
import { parseAndValidateAIToolArguments } from './ai.tools.js';
import { assertToolCallAllowedUnderImpersonation, isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

const MANAGED_ID = 'managed-1';
const CONNECTION_ID = 'connection-1';
const BINDING_TARGET = { targetNodeId: 'node-1', targetType: 'deployment', targetResourceId: 'deployment-1' } as const;
const BINDING_SCOPES = [
  'docker:containers:edit',
  'docker:containers:manage',
  'docker:containers:secrets',
  'docker:networks:create',
  'docker:networks:edit',
  'docker:networks:delete',
];

const user = (scopes: string[]) => ({ id: 'user-1', scopes }) as User;

function registerManagedDatabase(overrides: Record<string, unknown> = {}) {
  const service = {
    getCanonicalScopeResourceId: vi.fn().mockResolvedValue(CONNECTION_ID),
    revealCredentials: vi.fn().mockResolvedValue({ username: 'direct', password: 'secret' }),
    rotateDirectAccessCredentials: vi.fn().mockResolvedValue({ username: 'direct', password: 'rotated' }),
    getLogs: vi.fn().mockResolvedValue(['ready']),
    update: vi.fn().mockResolvedValue({ id: MANAGED_ID }),
    ...overrides,
  };
  const bindings = {
    getTarget: vi.fn().mockResolvedValue(BINDING_TARGET),
    getRuntime: vi.fn().mockResolvedValue({ binding: { id: 'binding-1' }, runtime: {} }),
    revealCredentials: vi.fn().mockResolvedValue({ connectionUri: 'postgresql://x', password: 'secret' }),
  };
  const license = {
    requireFeature: vi.fn().mockResolvedValue(undefined),
    requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(ManagedDatabaseService, service as unknown as ManagedDatabaseService);
  container.registerInstance(ManagedDatabaseBindingService, bindings as unknown as ManagedDatabaseBindingService);
  container.registerInstance(LicensePolicyService, license as unknown as LicensePolicyService);
  return { service, bindings, license };
}

const run = (scopes: string[], args: Record<string, unknown>) =>
  executeResourceSetupTool(user(scopes), 'manage_managed_database', { databaseId: MANAGED_ID, ...args });

afterEach(() => container.reset());

describe('managed database credential, log and runtime tools', () => {
  it('reveals direct credentials with the reveal scope on the canonical connection', async () => {
    const { service, license } = registerManagedDatabase();

    await expect(
      run([`databases:credentials:reveal:${CONNECTION_ID}`], { operation: 'reveal_credentials' })
    ).resolves.toEqual({ username: 'direct', password: 'secret' });
    expect(service.getCanonicalScopeResourceId).toHaveBeenCalledWith(MANAGED_ID);
    expect(service.revealCredentials).toHaveBeenCalledWith(MANAGED_ID);
    // Revealing credentials of an existing managed database keeps working after the grace period.
    expect(license.requireFeatureForExistingRuntime).toHaveBeenCalledWith('external-database-connections');
    expect(license.requireFeature).not.toHaveBeenCalled();

    // A grant on the managed instance id or view access alone is not the route's grant.
    for (const scopes of [[`databases:credentials:reveal:${MANAGED_ID}`], ['databases:view', 'databases:edit']]) {
      await expect(run(scopes, { operation: 'reveal_credentials' })).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
    }
    expect(service.revealCredentials).toHaveBeenCalledTimes(1);
  });

  it('rotates direct credentials only with both edit and reveal', async () => {
    const { service } = registerManagedDatabase();

    await expect(run([`databases:edit:${CONNECTION_ID}`], { operation: 'rotate_credentials' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      run([`databases:credentials:reveal:${CONNECTION_ID}`], { operation: 'rotate_credentials' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(service.rotateDirectAccessCredentials).not.toHaveBeenCalled();

    await expect(
      run([`databases:edit:${CONNECTION_ID}`, `databases:credentials:reveal:${CONNECTION_ID}`], {
        operation: 'rotate_credentials',
      })
    ).resolves.toEqual({ username: 'direct', password: 'rotated' });
    expect(service.rotateDirectAccessCredentials).toHaveBeenCalledWith(MANAGED_ID, 'user-1');
  });

  it('reveals binding credentials only with target workload binding access', async () => {
    const { bindings } = registerManagedDatabase();

    await expect(
      run(['databases:credentials:reveal'], { operation: 'reveal_binding_credentials', bindingId: 'binding-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(bindings.revealCredentials).not.toHaveBeenCalled();

    await expect(
      run(['databases:view', ...BINDING_SCOPES], { operation: 'reveal_binding_credentials', bindingId: 'binding-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      run(['databases:credentials:reveal', ...BINDING_SCOPES], {
        operation: 'reveal_binding_credentials',
        bindingId: 'binding-1',
      })
    ).resolves.toMatchObject({ password: 'secret' });
    expect(bindings.getTarget).toHaveBeenCalledWith(MANAGED_ID, 'binding-1');
    expect(bindings.revealCredentials).toHaveBeenCalledWith(MANAGED_ID, 'binding-1');
  });

  it('reads binding runtime with database view and target workload view', async () => {
    const { bindings } = registerManagedDatabase();

    await expect(
      run(['databases:view'], { operation: 'get_binding_runtime', bindingId: 'binding-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      run(['databases:view', 'docker:containers:view:node-1'], {
        operation: 'get_binding_runtime',
        bindingId: 'binding-1',
      })
    ).resolves.toMatchObject({ binding: { id: 'binding-1' } });
    expect(bindings.getRuntime).toHaveBeenCalledWith(MANAGED_ID, 'binding-1');
  });

  it('reads container logs through the canonical connection with the route tail bounds', async () => {
    const { service } = registerManagedDatabase();

    await expect(
      run([`databases:view:${CONNECTION_ID}`], { operation: 'logs', tailLines: 99_999, timestamps: false })
    ).resolves.toEqual(['ready']);
    expect(service.getLogs).toHaveBeenCalledWith(CONNECTION_ID, {
      tailLines: 5_000,
      follow: false,
      timestamps: false,
    });
    await run(['databases:view'], { operation: 'logs' });
    expect(service.getLogs).toHaveBeenLastCalledWith(CONNECTION_ID, {
      tailLines: 500,
      follow: false,
      timestamps: true,
    });
    await expect(run([`databases:view:${MANAGED_ID}`], { operation: 'logs' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('authorizes existing lifecycle operations through the canonical connection like the routes', async () => {
    const { service } = registerManagedDatabase();

    await run([`databases:edit:${CONNECTION_ID}`], { operation: 'update', memoryMb: 1024 });
    expect(service.update).toHaveBeenCalledWith(MANAGED_ID, { memoryMb: 1024 }, 'user-1');
    await expect(run([`databases:edit:${MANAGED_ID}`], { operation: 'update', memoryMb: 1024 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lists managed databases visible through canonical connection grants', async () => {
    registerManagedDatabase({
      list: vi.fn().mockResolvedValue([
        { id: MANAGED_ID, databaseConnectionId: CONNECTION_ID },
        { id: 'managed-2', databaseConnectionId: 'connection-2' },
      ]),
    });

    await expect(
      executeResourceSetupTool(user([`databases:view:${CONNECTION_ID}`]), 'manage_managed_database', {
        operation: 'list',
      })
    ).resolves.toEqual([{ id: MANAGED_ID, databaseConnectionId: CONNECTION_ID }]);
  });
});

describe('database, storage and backup tool argument validation', () => {
  it('accepts the new operations with their arguments', () => {
    for (const [tool, args] of [
      ['manage_managed_database', { operation: 'reveal_credentials', databaseId: MANAGED_ID }],
      ['manage_managed_database', { operation: 'rotate_credentials', databaseId: MANAGED_ID }],
      ['manage_managed_database', { operation: 'logs', databaseId: MANAGED_ID, tailLines: 100 }],
      ['manage_managed_database', { operation: 'reveal_binding_credentials', databaseId: MANAGED_ID, bindingId: 'b' }],
      ['manage_database_connection', { operation: 'monitoring', databaseId: 'db-1' }],
      ['manage_database_connection', { operation: 'create', type: 'clickhouse', name: 'ch', folderId: null }],
      ['manage_postgres_data', { operation: 'enable_extension', databaseId: 'db-1', extension: 'pg_trgm' }],
      ['manage_postgres_data', { operation: 'sql_execute', databaseId: 'db-1', sql: 'SELECT 1', maxRows: 10 }],
      ['manage_postgres_data', { operation: 'sql_update_row', databaseId: 'db-1', locator: { id: 1 }, values: {} }],
      ['manage_storage_connection', { action: 'reveal_credentials', storageId: 'storage-1' }],
      ['manage_storage_objects', { action: 'read_object', storageId: 'storage-1', config: { bucket: 'b', key: 'k' } }],
      ['manage_managed_storage', { action: 'reveal_credentials', managedStorageId: 'managed-1' }],
      ['manage_logging', { resource: 'health', operation: 'get' }],
      [
        'manage_database_backups',
        {
          action: 'restore',
          databaseId: 'db-1',
          runId: 'run-1',
          config: { executorNodeId: 'node-1', newManagedDatabaseName: 'copy', targetDatabaseName: 'app' },
        },
      ],
    ] as const) {
      expect(parseAndValidateAIToolArguments(tool, JSON.stringify(args)), tool).toMatchObject({ ok: true });
    }
  });

  it('rejects unknown operations, arguments and malformed extension names', () => {
    expect(
      parseAndValidateAIToolArguments(
        'manage_postgres_data',
        JSON.stringify({ operation: 'enable_extension', databaseId: 'db-1', extension: 'pg_trgm; drop' })
      )
    ).toEqual({ ok: false, error: 'Invalid tool arguments at /extension' });
    expect(
      parseAndValidateAIToolArguments(
        'manage_database_connection',
        JSON.stringify({ operation: 'test', databaseId: 'db-1', password: 'x' })
      )
    ).toEqual({ ok: false, error: 'Invalid tool arguments at $/password' });
    expect(
      parseAndValidateAIToolArguments(
        'manage_database_backups',
        JSON.stringify({ action: 'cancel', databaseId: 'db-1', runId: 'run-1', config: { force: true, extra: 1 } })
      )
    ).toEqual({ ok: false, error: 'Invalid tool arguments at /config/extra' });
    expect(
      parseAndValidateAIToolArguments(
        'manage_managed_database',
        JSON.stringify({ operation: 'rotate_password', databaseId: MANAGED_ID })
      )
    ).toEqual({ ok: false, error: 'Invalid tool arguments at /operation' });
  });
});

describe('credential tool impersonation policy', () => {
  const impersonation = {
    actorUserId: 'admin-1',
    subjectUserId: 'user-1',
    subjectEmail: 'user@example.com',
    subjectName: 'User',
  };

  it('blocks every credential reveal and rotation, but not ordinary reads', () => {
    for (const operation of ['reveal_credentials', 'rotate_credentials', 'reveal_binding_credentials']) {
      expect(isImpersonationBlockedToolCall('manage_managed_database', { operation })).toBe(true);
    }
    for (const operation of ['get', 'logs', 'get_binding_runtime', 'rotate_certificate']) {
      expect(isImpersonationBlockedToolCall('manage_managed_database', { operation })).toBe(false);
    }
    expect(isImpersonationBlockedToolCall('manage_managed_storage', { action: 'reveal_credentials' })).toBe(true);
    expect(isImpersonationBlockedToolCall('manage_managed_storage', { action: 'list_access_keys' })).toBe(false);
    expect(isImpersonationBlockedToolCall('manage_storage_connection', { action: 'reveal_credentials' })).toBe(true);
    expect(isImpersonationBlockedToolCall('manage_storage_connection', { action: 'health_history' })).toBe(false);
  });

  it('refuses a managed database reveal while impersonating', () => {
    const args = { operation: 'reveal_binding_credentials', databaseId: MANAGED_ID, bindingId: 'binding-1' };
    expect(() => assertToolCallAllowedUnderImpersonation('manage_managed_database', args)).not.toThrow();
    runWithAuditRequestContext({ impersonation }, () => {
      expect(() => assertToolCallAllowedUnderImpersonation('manage_managed_database', args)).toThrow(
        expect.objectContaining({ statusCode: 403, code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' })
      );
    });
  });
});
