import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_DATABASE_CONNECTOR_IMAGE } from '@/config/env.js';
import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';

function service(
  connectorImage = 'registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  allowDevelopmentConnectorImage = false
) {
  return new ManagedDatabaseBindingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    connectorImage,
    allowDevelopmentConnectorImage
  );
}

describe('managed database binding provisioning guardrails', () => {
  it('emits canonical database and Docker resource identifiers for binding changes', () => {
    const instance = service() as any;
    const publish = vi.fn();
    instance.setEventBus({ publish, subscribe: vi.fn() } as never);

    instance.emitBinding(
      {
        id: 'managed-database-1',
        databaseConnectionId: 'database-connection-1',
        name: 'orders',
        type: 'postgres',
      },
      {
        id: 'binding-1',
        status: 'ready',
        targetNodeId: 'node-1',
        targetType: 'deployment',
        targetResourceId: 'deployment-1',
      },
      'binding.ready'
    );

    expect(publish).toHaveBeenCalledWith(
      'database.changed',
      expect.objectContaining({ id: 'database-connection-1', bindingId: 'binding-1' })
    );
    expect(publish).toHaveBeenCalledWith(
      'docker.container.changed',
      expect.objectContaining({ nodeId: 'node-1', scopeResourceId: 'deployment-1' })
    );
  });

  it('mounts only the daemon-provided socket directory so connectors follow a replaced socket inode', () => {
    const instance = service() as any;
    expect(
      instance.tunnelSocketMount(JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' }))
    ).toEqual({
      hostDirectory: '/var/lib/docker-daemon/database-tunnel',
      connectorPath: '/run/gateway-db/tunnel.sock',
    });
    expect(() => instance.tunnelSocketMount(JSON.stringify({ socketPath: '../database-tunnel.sock' }))).toThrow();
    expect(() => instance.tunnelSocketMount(JSON.stringify({ socketPath: '/database-tunnel.sock' }))).toThrow();
  });

  it('does not accept a failed daemon command as provisioned', () => {
    const instance = service() as any;
    expect(() => instance.requireSuccess({ success: false, error: 'sensitive daemon detail' })).toThrow(
      'daemon operation failed'
    );
  });

  it('reconciles ready ClickHouse bindings through the versioned secure-principal action', async () => {
    const database = {
      id: '44444444-4444-4444-8444-444444444444',
      nodeId: '22222222-2222-4222-8222-222222222222',
      type: 'clickhouse',
      status: 'ready',
      pendingOperation: null,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'ready',
      encryptedCredentials: JSON.stringify({ encryptedKey: 'binding-key', encryptedDek: 'binding-dek' }),
    };
    const ownerBinding = {
      id: '66666666-6666-4666-8666-666666666666',
      status: 'ready',
      encryptedCredentials: database.encryptedOwnerCredentials,
    };
    const sendDockerDatabaseCommand = vi.fn().mockResolvedValue({ success: true });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn().mockResolvedValue([
            { database, binding },
            { database, binding: ownerBinding },
          ]),
        })),
      })),
    };
    const instance = new ManagedDatabaseBindingService(
      db as never,
      {} as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'binding-key'
              ? { username: 'gw_clickhouse_binding_123', password: 'binding-password', databaseName: 'app' }
              : { username: 'clickhouse_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
      } as never,
      { sendDockerDatabaseCommand } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    );

    await instance.reconcileBindingPrincipals();

    expect(sendDockerDatabaseCommand).toHaveBeenCalledTimes(1);
    expect(sendDockerDatabaseCommand).toHaveBeenCalledWith(
      database.nodeId,
      'clickhouse_principal_apply_v1',
      database.id,
      expect.any(String)
    );
    const command = JSON.parse(sendDockerDatabaseCommand.mock.calls[0]![3]) as Record<string, unknown>;
    expect(command).toMatchObject({
      principalType: 'binding',
      username: 'gw_clickhouse_binding_123',
      password: 'binding-password',
      ownerUsername: 'clickhouse_owner',
    });
    expect(JSON.stringify(command)).not.toContain('reconcileOnly');
  });

  it('reapplies ready PostgreSQL bindings through the backward-compatible binding action', async () => {
    const database = {
      id: '44444444-4444-4444-8444-444444444444',
      nodeId: '22222222-2222-4222-8222-222222222222',
      type: 'postgres',
      status: 'ready',
      pendingOperation: null,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'ready',
      encryptedCredentials: JSON.stringify({ encryptedKey: 'binding-key', encryptedDek: 'binding-dek' }),
    };
    const sendDockerDatabaseCommand = vi.fn().mockResolvedValue({ success: true });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
      })),
    };
    const instance = new ManagedDatabaseBindingService(
      db as never,
      {} as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'binding-key'
              ? { username: 'gw_postgres_binding_123', password: 'binding-password', databaseName: 'app' }
              : { username: 'postgres_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
      } as never,
      { sendDockerDatabaseCommand } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    );

    await instance.reconcileBindingPrincipals();

    expect(sendDockerDatabaseCommand).toHaveBeenCalledTimes(1);
    expect(sendDockerDatabaseCommand).toHaveBeenCalledWith(
      database.nodeId,
      'binding_create',
      database.id,
      expect.any(String)
    );
    const command = JSON.parse(sendDockerDatabaseCommand.mock.calls[0]![3]) as Record<string, unknown>;
    expect(command).toMatchObject({
      bindingId: binding.id,
      username: 'gw_postgres_binding_123',
      password: 'binding-password',
      databaseName: 'app',
      ownerUsername: 'postgres_owner',
      ownerPassword: 'owner-password',
    });
  });

  it('allows only the fixed local connector image with the explicit development flag', () => {
    const development = service(DEVELOPMENT_DATABASE_CONNECTOR_IMAGE, true) as any;
    const production = service(DEVELOPMENT_DATABASE_CONNECTOR_IMAGE, false) as any;
    const arbitrary = service('registry.example.com/connector:dev', true) as any;

    expect(() => development.assertConnectorImage()).not.toThrow();
    expect(development.connectorImageAction()).toBe('ensure-local');
    expect(() => production.assertConnectorImage()).toThrow('immutable digest');
    expect(production.connectorImageAction()).toBe('ensure');
    expect(() => arbitrary.assertConnectorImage()).toThrow('immutable digest');
  });

  it('continues binding teardown when the target container was already removed', async () => {
    const sendDockerNetworkCommand = vi.fn().mockResolvedValue({ success: true });
    const getContainerEnv = vi
      .fn()
      .mockRejectedValue(new Error('container inspect: No such container: deleted-target'));
    const updateContainerEnv = vi.fn();
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      { decryptString: () => JSON.stringify({ username: 'app', password: 'secret', databaseName: 'app' }) } as never,
      { sendDockerNetworkCommand } as never,
      { getContainerEnv, updateContainerEnv } as never,
      {} as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;

    await expect(
      instance.removeTargetBinding(
        { type: 'postgres' },
        {
          targetType: 'container',
          targetNodeId: 'node-1',
          targetResourceId: 'deleted-target',
          connectorAlias: 'db-link',
          networkName: 'managed-db-network',
          environment: { connectionUri: 'DATABASE_URL' },
          encryptedCredentials: JSON.stringify({ encryptedKey: 'key', encryptedDek: 'dek' }),
        },
        'user-1'
      )
    ).resolves.toBeUndefined();

    expect(updateContainerEnv).not.toHaveBeenCalled();
    expect(sendDockerNetworkCommand).toHaveBeenCalledWith('node-1', 'disconnect', {
      networkId: 'managed-db-network',
      containerId: 'deleted-target',
    });
  });

  it('removes the database principal before deleting the binding record', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'postgres',
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'target-node-1',
      targetType: 'container',
      targetResourceId: 'app-container',
      connectorName: 'database-connector',
      connectorAlias: 'database-link',
      networkName: 'database-network',
      environment: {},
      encryptedCredentials: JSON.stringify({ encryptedKey: 'binding-key', encryptedDek: 'binding-dek' }),
      status: 'ready',
    };
    let selectCount = 0;
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockImplementation(async () => (selectCount++ === 0 ? [database] : [binding])),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([binding]) })) })),
      })),
      delete: vi.fn(() => ({ where: deleteWhere })),
    };
    const sendDockerDatabaseCommand = vi.fn().mockResolvedValue({ success: true });
    const instance = new ManagedDatabaseBindingService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'binding-key'
              ? { username: 'app_user', password: 'binding-password', databaseName: 'app' }
              : { username: 'app_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
      } as never,
      {
        sendDockerDatabaseCommand,
        sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }),
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      {
        getContainerEnv: vi.fn().mockResolvedValue([]),
        updateContainerEnv: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    );

    await expect(instance.delete(database.id, binding.id, 'user-1')).resolves.toEqual({ success: true });

    expect(sendDockerDatabaseCommand).toHaveBeenCalledWith(
      database.nodeId,
      'binding_remove_v2',
      database.id,
      expect.any(String)
    );
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(sendDockerDatabaseCommand.mock.invocationCallOrder[0]).toBeLessThan(
      deleteWhere.mock.invocationCallOrder[0]!
    );
  });

  it('retains the binding record when database principal removal fails', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'postgres',
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'target-node-1',
      targetType: 'container',
      targetResourceId: 'app-container',
      connectorName: 'database-connector',
      connectorAlias: 'database-link',
      networkName: 'database-network',
      environment: {},
      encryptedCredentials: JSON.stringify({ encryptedKey: 'binding-key', encryptedDek: 'binding-dek' }),
      status: 'ready',
    };
    let selectCount = 0;
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockImplementation(async () => (selectCount++ === 0 ? [database] : [binding])),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([binding]) })) })),
      })),
      delete: vi.fn(() => ({ where: deleteWhere })),
    };
    const instance = new ManagedDatabaseBindingService(
      db as never,
      { log: vi.fn() } as never,
      {
        decryptString: vi.fn((encrypted: { encryptedKey: string }) =>
          JSON.stringify(
            encrypted.encryptedKey === 'binding-key'
              ? { username: 'app_user', password: 'binding-password', databaseName: 'app' }
              : { username: 'app_owner', password: 'owner-password', databaseName: 'app' }
          )
        ),
      } as never,
      {
        sendDockerDatabaseCommand: vi.fn().mockResolvedValue({ success: false, error: 'role still referenced' }),
        sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }),
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      {
        getContainerEnv: vi.fn().mockResolvedValue([]),
        updateContainerEnv: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    );

    await instance.delete(database.id, binding.id, 'user-1');

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});
