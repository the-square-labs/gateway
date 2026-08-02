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
  it('accepts only the daemon-provided absolute tunnel socket path', () => {
    const instance = service() as any;
    expect(
      instance.tunnelSocketPath(JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel.sock' }))
    ).toBe('/var/lib/docker-daemon/database-tunnel.sock');
    expect(() => instance.tunnelSocketPath(JSON.stringify({ socketPath: '../database-tunnel.sock' }))).toThrow();
  });

  it('does not accept a failed daemon command as provisioned', () => {
    const instance = service() as any;
    expect(() => instance.requireSuccess({ success: false, error: 'sensitive daemon detail' })).toThrow(
      'daemon operation failed'
    );
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
});
