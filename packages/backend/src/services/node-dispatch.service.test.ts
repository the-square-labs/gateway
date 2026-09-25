import { describe, expect, it, vi } from 'vitest';
import { NodeDispatchService } from './node-dispatch.service.js';

function createService(
  nodeType = 'docker',
  node: Record<string, unknown> = { status: 'online', capabilities: { capabilities: [] } }
) {
  const registry = {
    sendCommand: vi.fn().mockResolvedValue({ success: true }),
    hasCapability: vi.fn().mockReturnValue(true),
    getNode: vi.fn().mockReturnValue({ connectionId: 'connection-1' }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: vi.fn().mockResolvedValue([{ type: nodeType, ...node }]) }),
      }),
    }),
  };
  const service = new NodeDispatchService(registry as never, db as never);
  return { registry, service };
}

describe('NodeDispatchService', () => {
  it('forwards a bounded Docker log deadline to the pending-command registry', async () => {
    const { registry, service } = createService();
    await service.sendDockerLogsCommand('node-1', 'failed', { tailLines: 30, follow: false }, 1500);
    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      { dockerLogs: { containerId: 'failed', tailLines: 30, follow: false } },
      1500
    );
  });

  it('forwards per-user session keys for Docker and node consoles', async () => {
    const { registry, service } = createService();

    await service.sendDockerExecCommand('node-1', 'create', {
      containerId: 'container-1',
      sessionKey: 'user-1',
    });
    await service.sendNodeExecCommand('node-1', 'create', {
      sessionKey: 'user-1',
    });

    expect(registry.sendCommand).toHaveBeenNthCalledWith(
      1,
      'node-1',
      {
        dockerExec: {
          action: 'create',
          containerId: 'container-1',
          sessionKey: 'user-1',
        },
      },
      undefined
    );
    expect(registry.sendCommand).toHaveBeenNthCalledWith(
      2,
      'node-1',
      {
        nodeExec: {
          action: 'create',
          sessionKey: 'user-1',
        },
      },
      undefined
    );
  });

  it('sends docker file string content as UTF-8 bytes', async () => {
    const { registry, service } = createService();

    await service.sendDockerFileCommand('node-1', 'write', {
      containerId: 'container-1',
      path: '/tmp/file.txt',
      content: 'Hello',
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerFile: {
        action: 'write',
        containerId: 'container-1',
        path: '/tmp/file.txt',
        content: Buffer.from('Hello'),
      },
    });
  });

  it('passes docker file buffer content through unchanged', async () => {
    const { registry, service } = createService();
    const content = Buffer.from([0, 1, 2, 3]);

    await service.sendDockerFileCommand('node-1', 'write', {
      containerId: 'container-1',
      path: '/tmp/file.bin',
      content,
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerFile: {
        action: 'write',
        containerId: 'container-1',
        path: '/tmp/file.bin',
        content,
      },
    });
  });

  it.each([
    'storage',
    'databases',
  ])('uses a bounded long timeout for managed database operations on %s', async (role) => {
    const { registry, service } = createService(role);

    await service.sendDockerDatabaseCommand('node-1', 'create', 'database-1', '{"operationId":"op-1"}');

    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      { dockerDatabase: { action: 'create', managedDatabaseId: 'database-1', configJson: '{"operationId":"op-1"}' } },
      15 * 60 * 1000
    );
  });

  it.each(['storage', 'databases'])('capability-gates managed storage commands on %s', async (role) => {
    const storage = createService(role, { capabilities: { capabilities: ['managed_storage_v1'] } });

    await storage.service.sendDockerStorageCommand('node-1', 'create', 'storage-1', '{"version":1}');

    expect(storage.registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      { dockerStorage: { action: 'create', managedStorageId: 'storage-1', configJson: '{"version":1}' } },
      15 * 60 * 1000
    );

    const generic = createService('docker', { capabilities: { capabilities: ['managed_storage_v1'] } });
    await expect(generic.service.sendDockerStorageCommand('node-1', 'inspect', 'storage-1')).rejects.toMatchObject({
      code: 'NODE_TYPE_MISMATCH',
    });
    expect(generic.registry.sendCommand).not.toHaveBeenCalled();
    const oldWorker = createService(role);
    await expect(oldWorker.service.sendDockerStorageCommand('node-1', 'create', 'storage-1')).rejects.toMatchObject({
      code: 'STORAGE_CAPABILITY_UNAVAILABLE',
    });
    expect(oldWorker.registry.sendCommand).not.toHaveBeenCalled();
  });

  it('translates legacy IAM dispatch options into the typed storage command', async () => {
    const { registry, service } = createService('storage', {
      capabilities: { capabilities: ['managed_storage_iam_v1'] },
    });

    await service.sendDockerStorageIamCommand('node-1', 'list_keys', 'storage-1', {
      publishedPort: 0,
      useTls: false,
      rootAccessKey: 'root-access',
      rootSecretKey: 'root-secret',
    });

    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      {
        dockerStorage: {
          action: 'iam_list_keys',
          managedStorageId: 'storage-1',
          configJson: JSON.stringify({
            version: 1,
            rootCredentials: { accessKey: 'root-access', secretKey: 'root-secret' },
            tls: undefined,
            iam: {
              action: 'list_keys',
              targetAccessKey: '',
              targetSecretKey: '',
              name: '',
              policy: '',
              expiresAt: '',
            },
          }),
        },
      },
      15 * 60 * 1000
    );
  });

  it('refuses SeaweedFS storage work on a daemon without the SeaweedFS capability', async () => {
    const oldDaemon = createService('storage', {
      capabilities: { capabilities: ['managed_storage_v1', 'managed_storage_iam_v1'] },
    });

    await expect(
      oldDaemon.service.sendDockerStorageCommand(
        'node-1',
        'create',
        'storage-1',
        '{"version":2}',
        undefined,
        'seaweedfs'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'STORAGE_ENGINE_UNAVAILABLE' });
    await expect(
      oldDaemon.service.sendDockerStorageIamCommand('node-1', 'create_key', 'storage-1', {
        publishedPort: 0,
        useTls: false,
        rootAccessKey: 'root-access',
        rootSecretKey: 'root-secret',
        engine: 'seaweedfs',
        principal: 'gw-key-1',
      })
    ).rejects.toMatchObject({ code: 'STORAGE_ENGINE_UNAVAILABLE' });
    expect(oldDaemon.registry.sendCommand).not.toHaveBeenCalled();

    // Legacy MinIO work on the same daemon is unaffected.
    await oldDaemon.service.sendDockerStorageCommand('node-1', 'update', 'storage-1', '{"version":1}');
    expect(oldDaemon.registry.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('sends the SeaweedFS IAM payload with the engine and principal', async () => {
    const { registry, service } = createService('storage', {
      capabilities: {
        capabilities: ['managed_storage_v1', 'managed_storage_iam_v1', 'managed_storage_seaweedfs_v1'],
      },
    });

    await service.sendDockerStorageIamCommand('node-1', 'create_key', 'storage-1', {
      publishedPort: 0,
      useTls: true,
      caPem: 'ca-pem',
      serverName: 'localhost',
      rootAccessKey: 'root-access',
      rootSecretKey: 'root-secret',
      engine: 'seaweedfs',
      principal: 'gw-key-1',
      targetAccessKey: 'GWKEY',
      targetSecretKey: 'secret',
      name: 'ci',
      policy: '{"Version":"2012-10-17","Statement":[]}',
    });

    const command = registry.sendCommand.mock.calls[0]![1] as { dockerStorage: { configJson: string } };
    expect(JSON.parse(command.dockerStorage.configJson)).toEqual({
      version: 1,
      engine: 'seaweedfs',
      rootCredentials: { accessKey: 'root-access', secretKey: 'root-secret' },
      tls: { caPem: 'ca-pem', serverName: 'localhost' },
      iam: {
        action: 'create_key',
        principal: 'gw-key-1',
        targetAccessKey: 'GWKEY',
        targetSecretKey: 'secret',
        name: 'ci',
        policy: '{"Version":"2012-10-17","Statement":[]}',
        expiresAt: '',
      },
    });

    await expect(
      service.sendDockerStorageIamCommand('node-1', 'remove_key', 'storage-1', {
        publishedPort: 0,
        useTls: false,
        rootAccessKey: 'root-access',
        rootSecretKey: 'root-secret',
        engine: 'seaweedfs',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_STORAGE_IAM_PRINCIPAL_REQUIRED' });
  });

  it('capability-gates and dispatches typed Compose commands', async () => {
    const unsupported = createService();
    unsupported.registry.hasCapability.mockReturnValue(false);
    await expect(
      unsupported.service.sendDockerComposeCommand('node-1', 'apply', {
        operationId: 'operation-1',
        projectId: 'project-1',
        projectName: 'demo',
      })
    ).rejects.toMatchObject({ code: 'COMPOSE_CAPABILITY_UNAVAILABLE' });
    expect(unsupported.registry.sendCommand).not.toHaveBeenCalled();

    const supported = createService();
    await supported.service.sendDockerComposeCommand('node-1', 'apply', {
      operationId: 'operation-1',
      projectId: 'project-1',
      projectName: 'demo',
      revisionId: 'revision-1',
      configDigest: 'sha256:digest',
      composeYaml: Buffer.from('services: {}'),
      normalizedModelJson: '{"services":{}}',
      variables: { TAG: 'latest' },
      secrets: { TOKEN: 'secret' },
      removeOrphans: true,
      volumeNames: ['data'],
    });

    expect(supported.registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      {
        dockerCompose: {
          action: 'apply',
          operationId: 'operation-1',
          projectId: 'project-1',
          projectName: 'demo',
          revisionId: 'revision-1',
          configDigest: 'sha256:digest',
          composeYaml: Buffer.from('services: {}'),
          normalizedModelJson: '{"services":{}}',
          variables: { TAG: 'latest' },
          secrets: { TOKEN: 'secret' },
          removeOrphans: true,
          volumeNames: ['data'],
        },
      },
      30 * 60 * 1000
    );
  });

  it('drops Compose logging settings for a node whose daemon cannot apply them', async () => {
    const command = {
      operationId: 'operation-1',
      projectId: 'project-1',
      projectName: 'demo',
      revisionId: 'revision-1',
      configDigest: 'sha256:digest',
      composeYaml: Buffer.from(
        'services:\n  web:\n    image: nginx\n    logging:\n      driver: local\n  worker:\n    image: busybox\n'
      ),
      normalizedModelJson: JSON.stringify({
        name: 'demo',
        services: { web: { image: 'nginx', logging: { driver: 'local' } }, worker: { image: 'busybox' } },
      }),
    };
    const sent = (service: ReturnType<typeof createService>) =>
      service.registry.sendCommand.mock.calls[0][1].dockerCompose as {
        composeYaml: Buffer;
        normalizedModelJson: string;
      };

    const older = createService();
    older.registry.hasCapability.mockImplementation(
      (_nodeId: string, capability: string) => capability !== 'compose_logging_v1'
    );
    await older.service.sendDockerComposeCommand('node-1', 'apply', command);
    expect(sent(older).composeYaml.toString()).toBe(
      'services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n'
    );
    expect(JSON.parse(sent(older).normalizedModelJson)).toEqual({
      name: 'demo',
      services: { web: { image: 'nginx' }, worker: { image: 'busybox' } },
    });

    const updated = createService();
    await updated.service.sendDockerComposeCommand('node-1', 'apply', command);
    expect(sent(updated).composeYaml).toBe(command.composeYaml);
    expect(sent(updated).normalizedModelJson).toBe(command.normalizedModelJson);
  });

  it('generation-normalizes and capability-gates Docker Availability commands', async () => {
    const unsupported = createService();
    unsupported.registry.hasCapability.mockReturnValue(false);
    await expect(
      unsupported.service.sendDockerAvailabilityCommand('node-1', {
        action: 'prepare',
        policyId: 'policy-1',
        placementId: 'placement-1',
        generation: 3,
        operationId: 'operation-1',
        idempotencyKey: 'key-1',
        resourceKind: 'container',
        resourceId: 'api',
        configJson: '{}',
      })
    ).rejects.toMatchObject({ code: 'AVAILABILITY_CAPABILITY_UNAVAILABLE' });

    const supported = createService();
    await supported.service.sendDockerAvailabilityCommand('node-1', {
      action: 'activate',
      policyId: 'policy-1',
      placementId: 'placement-1',
      generation: 4,
      operationId: 'operation-1',
      idempotencyKey: 'key-2',
      resourceKind: 'container',
      resourceId: 'api',
      configJson: '{"containerId":"container-1"}',
    });
    expect(supported.registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      {
        dockerAvailability: {
          action: 'activate',
          policyId: 'policy-1',
          placementId: 'placement-1',
          generation: '4',
          operationId: 'operation-1',
          idempotencyKey: 'key-2',
          resourceKind: 'container',
          resourceId: 'api',
          configJson: '{"containerId":"container-1"}',
        },
      },
      undefined
    );
  });

  it.each(['before', 'during'])('keeps an Availability disconnect %s dispatch retryable', async (when) => {
    const { service, registry } = createService();
    if (when === 'before') registry.getNode.mockReturnValue(undefined as never);
    else registry.sendCommand.mockRejectedValue(new Error('Node disconnected'));
    await expect(
      service.sendDockerAvailabilityCommand('node-1', {
        action: 'inspect',
        policyId: 'policy',
        placementId: 'placement',
        generation: 3,
        operationId: 'operation',
        idempotencyKey: 'inspect',
        resourceKind: 'container',
        resourceId: 'app',
        configJson: '{}',
      })
    ).rejects.toMatchObject({ code: 'AVAILABILITY_NODE_DISCONNECTED', details: { retryable: true } });
    if (when === 'before') expect(registry.sendCommand).not.toHaveBeenCalled();
  });

  it('sends managed database logs through the restricted database command', async () => {
    const { registry, service } = createService('databases');

    await service.sendManagedDatabaseLogsCommand('node-1', 'database-1', {
      tailLines: 200,
      follow: true,
      timestamps: true,
    });

    expect(registry.sendCommand).toHaveBeenCalledWith('node-1', {
      dockerDatabase: {
        action: 'logs',
        managedDatabaseId: 'database-1',
        configJson: JSON.stringify({ tailLines: 200, follow: true, timestamps: true }),
      },
    });

    await service.stopManagedDatabaseLogStream('node-1', 'database-1');
    expect(registry.sendCommand).toHaveBeenLastCalledWith('node-1', {
      dockerDatabase: {
        action: 'logs_stop',
        managedDatabaseId: 'database-1',
        configJson: '{}',
      },
    });
  });

  it('never dispatches a Pages mutation without nginx_pages_v1', async () => {
    const { registry, service } = createService('nginx');

    await expect(service.sendPagesCommand('node-1', { pagesInventory: {} })).rejects.toMatchObject({
      code: 'PAGES_DAEMON_UPDATE_REQUIRED',
    });
    expect(registry.sendCommand).not.toHaveBeenCalled();
  });

  it.each([true, false])('gates Pages reconciliation on its advertised capability (%s)', async (supported) => {
    const { service, registry } = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: supported ? ['nginx_pages_v1', 'nginx_pages_reconcile_v1'] : ['nginx_pages_v1'] },
    });
    expect(await service.supportsPagesReconciliation('node-1')).toBe(supported);
    expect(registry.sendCommand).not.toHaveBeenCalled();
  });

  it('requires safe preview revocation support before removing project URLs', async () => {
    const old = createService('nginx', { status: 'online', capabilities: { capabilities: ['nginx_pages_v1'] } });
    await expect(old.service.assertPagesPreviewRevocation('node-1')).rejects.toMatchObject({
      code: 'PAGES_DAEMON_UPDATE_REQUIRED',
    });
    const current = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_preview_revocation_v1'] },
    });
    await expect(current.service.assertPagesPreviewRevocation('node-1')).resolves.toBeUndefined();
    expect(old.registry.sendCommand).not.toHaveBeenCalled();
  });

  it('dispatches and parses capability-gated Pages command data', async () => {
    const { registry, service } = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1'] },
    });
    registry.sendCommand.mockResolvedValue({ success: true, data: Buffer.from('{"available":true}') });

    await expect(
      service.sendPagesCommand('node-1', { pagesStoragePreflight: { requiredBytes: '0' } })
    ).resolves.toEqual({ available: true });
    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      { pagesStoragePreflight: { requiredBytes: '0' } },
      120_000
    );
  });

  it('requires the separate runtime-config capability for config commands', async () => {
    const withoutConfig = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1'] },
    });
    await expect(
      withoutConfig.service.sendPagesRuntimeConfigCommand('node-1', {
        pagesActivateRuntimeConfig: {
          bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
          bindingId: '11111111-1111-4111-8111-111111111111',
          generation: '1',
        },
      })
    ).rejects.toMatchObject({ code: 'PAGES_DAEMON_UPDATE_REQUIRED' });
    expect(withoutConfig.registry.sendCommand).not.toHaveBeenCalled();

    const withConfig = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_config_v1'] },
    });
    await expect(
      withConfig.service.sendPagesRuntimeConfigCommand('node-1', {
        pagesActivateRuntimeConfig: {
          bindingKind: 'PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE',
          bindingId: '11111111-1111-4111-8111-111111111111',
          generation: '1',
        },
      })
    ).resolves.toEqual({});
    expect(withConfig.registry.sendCommand).toHaveBeenCalledOnce();
  });

  it('skips Pages Route probes when the nginx daemon has not reported probe capability', async () => {
    const { registry, service } = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1'] },
    });

    await expect(
      service.probePagesRoute('node-1', {
        routeId: '11111111-1111-4111-8111-111111111111',
        domain: 'docs.example.com',
        tls: true,
        path: '/',
      })
    ).resolves.toMatchObject({ ok: false, skipped: true });
    expect(registry.sendCommand).not.toHaveBeenCalled();
  });

  it('dispatches and parses a capability-gated Pages Route probe', async () => {
    const { registry, service } = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_route_probe_v1'] },
    });
    registry.sendCommand.mockResolvedValue({
      success: true,
      detail: JSON.stringify({ ok: true, httpStatus: 204, responseMs: 9 }),
    });

    await expect(
      service.probePagesRoute('node-1', {
        routeId: '11111111-1111-4111-8111-111111111111',
        domain: 'docs.example.com',
        tls: true,
        path: '/health',
        expectedStatus: 204,
        expectedBody: 'ready',
        bodyMatchMode: 'exact',
        timeoutSeconds: 5,
      })
    ).resolves.toEqual({ ok: true, httpStatus: 204, responseMs: 9 });
    expect(registry.sendCommand).toHaveBeenCalledWith(
      'node-1',
      {
        probePagesRoute: {
          routeId: '11111111-1111-4111-8111-111111111111',
          domain: 'docs.example.com',
          tls: true,
          path: '/health',
          expectedStatus: 204,
          expectedBody: 'ready',
          bodyMatchMode: 'exact',
          timeoutSeconds: 5,
        },
      },
      10_000
    );
  });

  it('requires the socket-only capability only for hardened Secure Link source snapshots', async () => {
    const legacy = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['proxy_secure_links_v1'] },
    });

    await expect(
      legacy.service.sendProxySecureLinks('node-1', [
        {
          linkId: '11111111-1111-4111-8111-111111111111',
          role: 'source',
          generation: 1,
          socketOnly: true,
        },
      ])
    ).rejects.toMatchObject({ code: 'PROXY_SECURE_LINK_UPDATE_REQUIRED' });
    expect(legacy.registry.sendCommand).not.toHaveBeenCalled();

    await expect(
      legacy.service.sendProxySecureLinks('node-1', [
        {
          linkId: '11111111-1111-4111-8111-111111111111',
          role: 'source',
          generation: 1,
          socketOnly: false,
        },
      ])
    ).resolves.toEqual({ success: true });

    const hardened = createService('nginx', {
      status: 'online',
      capabilities: {
        capabilities: ['proxy_secure_links_v1', 'nginx_secure_link_socket_only_v1'],
      },
    });
    await expect(
      hardened.service.sendProxySecureLinks('node-1', [
        {
          linkId: '11111111-1111-4111-8111-111111111111',
          role: 'source',
          generation: 1,
          socketOnly: true,
        },
      ])
    ).resolves.toEqual({ success: true });
  });

  it('keeps registry cleanup compatible but gates non-empty socket-only ingress', async () => {
    const legacy = createService('nginx', {
      status: 'online',
      capabilities: { capabilities: ['nginx_registry_ingress_v1'] },
    });

    await expect(legacy.service.sendNginxRegistryBindings('node-1', [])).resolves.toEqual({ success: true });
    await expect(
      legacy.service.sendNginxRegistryBindings('node-1', [
        {
          bindingId: '11111111-1111-4111-8111-111111111111',
          role: 'ingress',
          generation: 1,
          repository: '*',
          actions: ['pull', 'push'],
          localAddress: '127.0.0.1',
          localPort: 5443,
          relayOwnerKind: 'registry_ingress',
          relayOwnerId: '11111111-1111-4111-8111-111111111111',
          authorization: '',
          authorizationExpiresAtUnix: 0,
        },
      ])
    ).rejects.toMatchObject({ code: 'NGINX_REGISTRY_INGRESS_UPDATE_REQUIRED' });

    const hardened = createService('nginx', {
      status: 'online',
      capabilities: {
        capabilities: ['nginx_registry_ingress_v1', 'nginx_secure_link_socket_only_v1'],
      },
    });
    await expect(
      hardened.service.sendNginxRegistryBindings('node-1', [
        {
          bindingId: '11111111-1111-4111-8111-111111111111',
          role: 'ingress',
          generation: 1,
          repository: '*',
          actions: ['pull', 'push'],
          localAddress: '127.0.0.1',
          localPort: 5443,
          relayOwnerKind: 'registry_ingress',
          relayOwnerId: '11111111-1111-4111-8111-111111111111',
          authorization: '',
          authorizationExpiresAtUnix: 0,
        },
      ])
    ).resolves.toEqual({ success: true });
  });
});
