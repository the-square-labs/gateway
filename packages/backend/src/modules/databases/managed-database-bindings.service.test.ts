import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_DATABASE_CONNECTOR_IMAGE } from '@/config/env.js';
import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';

function service(
  connectorImage = 'registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  allowDevelopmentConnectorImage = false
) {
  const instance = new ManagedDatabaseBindingService(
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
  instance.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
  return instance;
}

describe('managed database binding provisioning guardrails', () => {
  it('fails closed before creating a binding when license policy wiring is missing', async () => {
    const instance = service();
    (instance as any).licensePolicy = undefined;

    await expect(instance.create('database-1', {} as never, 'user-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

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

  it('refreshes relay grants and validates the connector after either binding node reconnects', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'redis',
      status: 'ready',
      pendingOperation: null,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'docker-node-1',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
      status: 'ready',
      encryptedCredentials: database.encryptedOwnerCredentials,
    };
    const socketPath = '/var/lib/docker-daemon/database-tunnel/tunnel.sock';
    const sendRelayGrantBundle = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ socketPath }),
    });
    const sendDockerContainerCommand = vi.fn(async (_nodeId: string, action: string, _payload?: unknown) => {
      if (action === 'inspect') {
        return {
          success: true,
          detail: JSON.stringify({
            Config: {
              Image: DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
              Env: [
                `GATEWAY_DB_BINDING_ID=${binding.id}`,
                'GATEWAY_DB_SOCKET=/run/gateway-db/tunnel.sock',
                'GATEWAY_DB_LISTEN=:6379',
              ],
              Labels: {
                'wiolett.gateway.managed-database.binding': binding.id,
                'wiolett.gateway.managed-database.connector': 'true',
              },
            },
            HostConfig: {
              Binds: ['/var/lib/docker-daemon/database-tunnel:/run/gateway-db:ro'],
              NetworkMode: binding.networkName,
              RestartPolicy: { Name: 'unless-stopped' },
            },
            NetworkSettings: { Networks: { [binding.networkName]: { Aliases: [binding.connectorAlias] } } },
          }),
        };
      }
      return { success: true };
    });
    const sendDockerNetworkCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
    });
    const ensureBindingRoute = vi.fn().mockResolvedValue(undefined);
    const getNodeGrantBundle = vi.fn(async () => ({ revision: '1', generatedAtUnixMs: '1', grants: [] }));
    const instance = new ManagedDatabaseBindingService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
        })),
      } as never,
      {} as never,
      {
        decryptString: vi.fn(() => JSON.stringify({ username: 'owner', password: 'secret', databaseName: 'app' })),
      } as never,
      { sendRelayGrantBundle, sendDockerContainerCommand, sendDockerNetworkCommand } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true,
      { ensureBindingRoute, getNodeGrantBundle, revokeOwner: vi.fn() }
    );

    await instance.reconcileBindingPrincipals(database.nodeId);

    expect(ensureBindingRoute).toHaveBeenCalledWith(binding.id, database.id, binding.targetNodeId, database.nodeId);
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(2);
    expect(sendDockerContainerCommand).toHaveBeenCalledWith(binding.targetNodeId, 'inspect', {
      containerId: binding.connectorName,
    });
    expect(sendDockerContainerCommand).toHaveBeenCalledWith(binding.targetNodeId, 'restart', {
      containerId: binding.connectorName,
    });

    sendRelayGrantBundle.mockClear();
    sendDockerContainerCommand.mockClear();
    await instance.reconcileBindingPrincipals(binding.targetNodeId);
    expect(sendRelayGrantBundle).toHaveBeenCalledTimes(2);
    expect(sendDockerContainerCommand).toHaveBeenCalledWith(binding.targetNodeId, 'restart', {
      containerId: binding.connectorName,
    });
  });

  it('reapplies the target binding after recreating a connector with a new network address', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'postgres',
      status: 'ready',
      pendingOperation: null,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'docker-node-1',
      targetType: 'compose_service',
      targetResourceId: 'project-1:relay',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
      environment: { connectionUri: 'DATABASE_URL' },
      status: 'ready',
      encryptedCredentials: database.encryptedOwnerCredentials,
    };
    const applyManagedDatabaseBinding = vi.fn().mockResolvedValue(undefined);
    const reconcileTargetNode = vi.fn().mockResolvedValue(undefined);
    const sendDockerContainerCommand = vi.fn(async (_nodeId: string, action: string) => {
      if (action === 'inspect') return { success: false, error: 'No such container' };
      if (action === 'create') return { success: true, detail: JSON.stringify({ id: 'c'.repeat(64) }) };
      return { success: true };
    });
    const instance = new ManagedDatabaseBindingService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
        })),
      } as never,
      {} as never,
      {
        decryptString: vi.fn(() => JSON.stringify({ username: 'owner', password: 'secret', databaseName: 'app' })),
      } as never,
      {
        sendRelayGrantBundle: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' }),
        }),
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
        }),
        sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
        sendDockerContainerCommand,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true,
      {
        ensureBindingRoute: vi.fn().mockResolvedValue(undefined),
        getNodeGrantBundle: vi.fn(async () => ({ revision: '1', generatedAtUnixMs: '1', grants: [] })),
        revokeOwner: vi.fn(),
      },
      { applyManagedDatabaseBinding } as never
    );
    instance.setTargetRuntimeReconciler({ reconcileTargetNode, releaseTargetNetwork: vi.fn() });

    await instance.reconcileBindingPrincipals(binding.targetNodeId);

    expect(applyManagedDatabaseBinding).toHaveBeenCalledWith(
      binding.targetNodeId,
      binding.targetResourceId,
      binding.id,
      binding.networkName,
      { DATABASE_URL: 'postgresql://owner:secret@db-binding-1:5432/app' },
      'system'
    );
    expect(reconcileTargetNode).toHaveBeenCalledWith(binding.targetNodeId);
  });

  it('restores a binding left in deletion error when either node reconnects', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'redis',
      status: 'ready',
      pendingOperation: null,
      encryptedOwnerCredentials: JSON.stringify({ encryptedKey: 'owner-key', encryptedDek: 'owner-dek' }),
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'docker-node-1',
      targetType: 'compose_service',
      targetResourceId: 'project-1:web',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
      environment: { connectionUri: 'DATABASE_URL' },
      status: 'error',
      lastError: 'Binding removal failed: network is in use',
      encryptedCredentials: database.encryptedOwnerCredentials,
    };
    const updateReturning = vi.fn().mockResolvedValue([{ ...binding, status: 'ready', lastError: null }]);
    const applyManagedDatabaseBinding = vi.fn().mockResolvedValue(undefined);
    const reconcileTargetNode = vi.fn().mockResolvedValue(undefined);
    const instance = new ManagedDatabaseBindingService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
        })),
      } as never,
      {} as never,
      {
        decryptString: vi.fn(() => JSON.stringify({ username: 'owner', password: 'secret', databaseName: 'app' })),
      } as never,
      {
        sendRelayGrantBundle: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' }),
        }),
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
        }),
        sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
          if (action === 'inspect') {
            return {
              success: true,
              detail: JSON.stringify({
                Config: {
                  Image: DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
                  Env: [
                    `GATEWAY_DB_BINDING_ID=${binding.id}`,
                    'GATEWAY_DB_SOCKET=/run/gateway-db/tunnel.sock',
                    'GATEWAY_DB_LISTEN=:6379',
                  ],
                  Labels: {
                    'wiolett.gateway.managed-database.binding': binding.id,
                    'wiolett.gateway.managed-database.connector': 'true',
                  },
                },
                HostConfig: {
                  Binds: ['/var/lib/docker-daemon/database-tunnel:/run/gateway-db:ro'],
                  NetworkMode: binding.networkName,
                  RestartPolicy: { Name: 'unless-stopped' },
                },
                NetworkSettings: { Networks: { [binding.networkName]: { Aliases: [binding.connectorAlias] } } },
              }),
            };
          }
          return { success: true };
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true,
      {
        ensureBindingRoute: vi.fn().mockResolvedValue(undefined),
        getNodeGrantBundle: vi.fn(async () => ({ revision: '1', generatedAtUnixMs: '1', grants: [] })),
        revokeOwner: vi.fn(),
      },
      { applyManagedDatabaseBinding } as never
    );
    instance.setTargetRuntimeReconciler({ reconcileTargetNode, releaseTargetNetwork: vi.fn() });

    await instance.reconcileBindingPrincipals(binding.targetNodeId);

    expect(applyManagedDatabaseBinding).toHaveBeenCalled();
    expect(reconcileTargetNode).toHaveBeenCalledWith(binding.targetNodeId);
    expect(updateReturning).toHaveBeenCalled();
  });

  it('retries durable cleanup for a binding left in provisioning error', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-1',
      type: 'postgres',
      status: 'ready',
      pendingOperation: null,
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'docker-node-1',
      status: 'error',
      lastError: 'Binding preparation failed: release failed',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const revokeOwner = vi.fn().mockResolvedValue(undefined);
    const instance = new ManagedDatabaseBindingService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
        })),
        delete: vi.fn(() => ({ where: deleteWhere })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true,
      { ensureBindingRoute: vi.fn(), getNodeGrantBundle: vi.fn(), revokeOwner }
    ) as any;
    const deprovisionBinding = vi.spyOn(instance, 'deprovisionBinding').mockResolvedValue(undefined);

    await instance.reconcileBindingPrincipals(binding.targetNodeId);

    expect(revokeOwner).toHaveBeenCalledWith('managed_database_binding', binding.id);
    expect(deprovisionBinding).toHaveBeenCalledWith(database, binding, 'system', {});
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('recreates a missing connector with the daemon-owned socket directory mount', async () => {
    const database = { type: 'postgres' };
    const binding = {
      id: 'binding-1',
      targetNodeId: 'node-1',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
    };
    const sendDockerContainerCommand = vi.fn(async (_nodeId: string, action: string, _payload?: unknown) => {
      if (action === 'inspect') return { success: false, error: 'No such container' };
      if (action === 'create') return { success: true, detail: JSON.stringify({ id: 'a'.repeat(64) }) };
      return { success: true };
    });
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {
        sendDockerContainerCommand,
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
        }),
        sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;

    await instance.ensureBindingConnector(
      database,
      binding,
      JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' })
    );

    const createCall = sendDockerContainerCommand.mock.calls.find((call) => call[1] === 'create');
    expect(createCall).toBeDefined();
    const config = JSON.parse((createCall![2] as { configJson: string }).configJson);
    expect(config.binds).toEqual(['/var/lib/docker-daemon/database-tunnel:/run/gateway-db:ro']);
    expect(config.network_mode).toBe(binding.networkName);
    expect(sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'start', { containerId: 'a'.repeat(64) });
  });

  it('replaces an owned connector that still mounts a stale socket inode', async () => {
    const database = { type: 'postgres' };
    const binding = {
      id: 'binding-1',
      targetNodeId: 'node-1',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
    };
    const sendDockerContainerCommand = vi.fn(async (_nodeId: string, action: string, _payload?: unknown) => {
      if (action === 'inspect') {
        return {
          success: true,
          detail: JSON.stringify({
            Config: {
              Image: DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
              Labels: {
                'wiolett.gateway.managed-database.binding': binding.id,
                'wiolett.gateway.managed-database.connector': 'true',
              },
            },
            HostConfig: {
              Binds: ['/var/lib/docker-daemon/database-tunnel/tunnel.sock:/run/gateway-db/tunnel.sock:ro'],
            },
          }),
        };
      }
      if (action === 'create') return { success: true, detail: JSON.stringify({ id: 'b'.repeat(64) }) };
      return { success: true };
    });
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {
        sendDockerContainerCommand,
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
        }),
        sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;

    await instance.ensureBindingConnector(
      database,
      binding,
      JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' })
    );

    expect(sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'remove', {
      containerId: binding.connectorName,
      force: true,
    });
    expect(sendDockerContainerCommand.mock.calls.some((call) => call[1] === 'create')).toBe(true);
  });

  it('refuses to replace a foreign container with the connector name', async () => {
    const binding = {
      id: 'binding-1',
      targetNodeId: 'node-1',
      connectorName: 'gateway-db-connector-binding-1',
      connectorAlias: 'db-binding-1',
      networkName: 'gateway-db-binding-1',
    };
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ Config: { Labels: { owner: 'someone-else' } } }),
    });
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {
        sendDockerContainerCommand,
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Name: binding.networkName, Driver: 'bridge' }]),
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;

    await expect(
      instance.ensureBindingConnector(
        { type: 'postgres' },
        binding,
        JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel/tunnel.sock' })
      )
    ).rejects.toThrow('is not owned by managed database binding');
    expect(sendDockerContainerCommand.mock.calls.some((call) => call[1] === 'remove')).toBe(false);
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

  it('releases dependent Secure Links before removing any binding target network', async () => {
    const releaseTargetNetwork = vi.fn().mockResolvedValue(undefined);
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;
    instance.setTargetRuntimeReconciler({ releaseTargetNetwork, reconcileTargetNode: vi.fn() });

    await instance.prepareTargetNetworkRemoval({
      targetType: 'compose_service',
      targetNodeId: 'node-1',
      networkName: 'database-network',
    });

    expect(releaseTargetNetwork).toHaveBeenCalledWith('node-1', 'database-network');
  });

  it('stops before target mutation when Secure Link network release fails', async () => {
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;
    instance.setTargetRuntimeReconciler({
      releaseTargetNetwork: vi.fn().mockRejectedValue(new Error('release failed')),
      reconcileTargetNode: vi.fn(),
    });

    await expect(
      instance.prepareTargetNetworkRemoval({
        targetType: 'deployment',
        targetNodeId: 'node-1',
        networkName: 'database-network',
      })
    ).rejects.toThrow('release failed');
  });

  it('does not remove connector resources when provisioning compensation cannot release Secure Links', async () => {
    const sendDockerNetworkCommand = vi.fn().mockResolvedValue({ success: true });
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true });
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      { sendDockerNetworkCommand, sendDockerContainerCommand } as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true
    ) as any;
    instance.setTargetRuntimeReconciler({
      releaseTargetNetwork: vi.fn().mockRejectedValue(new Error('release failed')),
      reconcileTargetNode: vi.fn(),
    });

    await expect(
      instance.compensateProvisioning(
        { type: 'postgres' },
        {
          id: 'binding-1',
          targetNodeId: 'node-1',
          targetType: 'container',
          targetResourceId: 'app-container',
          networkName: 'database-network',
        },
        {
          principalCreated: false,
          policyPrepared: false,
          networkCreated: true,
          connectorCreated: true,
          targetApplyAttempted: true,
        }
      )
    ).rejects.toThrow('release failed');

    expect(sendDockerContainerCommand).not.toHaveBeenCalled();
    expect(sendDockerNetworkCommand).not.toHaveBeenCalled();
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

  it('applies and removes a managed database link through Compose revisions', async () => {
    const applyManagedDatabaseBinding = vi.fn().mockResolvedValue(undefined);
    const removeManagedDatabaseBinding = vi.fn().mockResolvedValue(undefined);
    const instance = new ManagedDatabaseBindingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      DEVELOPMENT_DATABASE_CONNECTOR_IMAGE,
      true,
      undefined,
      { applyManagedDatabaseBinding, removeManagedDatabaseBinding } as never
    ) as any;
    const database = { type: 'postgres' };
    const binding = {
      id: '55555555-5555-4555-8555-555555555555',
      targetNodeId: '22222222-2222-4222-8222-222222222222',
      targetType: 'compose_service',
      targetResourceId: '44444444-4444-4444-8444-444444444444:api',
      networkName: 'gateway-db-5555555555554555',
      connectorAlias: 'db-5555555555554555',
      environment: { connectionUri: 'DATABASE_URL' },
    };
    const credentials = { username: 'app', password: 'secret', databaseName: 'app' };

    await instance.applyTargetBinding(database, binding, credentials, 'user-1');
    instance.bindingCredentials = vi.fn(() => credentials);
    await instance.removeTargetBinding(database, binding, 'user-1');

    expect(applyManagedDatabaseBinding).toHaveBeenCalledWith(
      binding.targetNodeId,
      binding.targetResourceId,
      binding.id,
      binding.networkName,
      expect.objectContaining({ DATABASE_URL: expect.stringContaining('postgresql://') }),
      'user-1'
    );
    expect(removeManagedDatabaseBinding).toHaveBeenCalledWith(
      binding.targetNodeId,
      binding.targetResourceId,
      binding.id,
      binding.networkName,
      expect.objectContaining({ DATABASE_URL: expect.stringContaining('postgresql://') }),
      'user-1'
    );
  });
});
