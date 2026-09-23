import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { assertComposeChildMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { listAvailableMcpTools } from '@/modules/mcp/mcp-tools.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { UpdateService } from '@/services/update.service.js';
import { AIService } from './ai.service.js';

vi.mock('@/modules/docker/compose/compose-child.guard.js', () => ({
  assertComposeChildMutationAllowed: vi.fn().mockResolvedValue(undefined),
  assertComposeVolumeMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const CERT_ID = '22222222-2222-4222-8222-222222222222';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const NODE_ID = '44444444-4444-4444-8444-444444444444';
const ALERT_ID = '55555555-5555-4555-8555-555555555555';

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

function userWith(scopes: string[]) {
  return { ...BASE_USER, scopes };
}

function createService(services: {
  proxyService?: Record<string, unknown>;
  sslService?: Record<string, unknown>;
  domainsService?: Record<string, unknown>;
  nodesService?: Record<string, unknown>;
  dockerService?: Record<string, unknown>;
}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (services.proxyService ?? {}) as never,
    {} as never,
    (services.sslService ?? {}) as never,
    (services.domainsService ?? {}) as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    (services.nodesService ?? {}) as never,
    {} as never,
    {} as never,
    (services.dockerService ?? {}) as never
  );
}

afterEach(() => {
  vi.clearAllMocks();
  container.reset();
});

describe('TLS repair and certificate tools', () => {
  it('resyncs route TLS and certificate distribution only with admin:update', async () => {
    const proxyService = { resyncTlsHost: vi.fn().mockResolvedValue({ synchronized: true }) };
    const sslService = { resyncDistribution: vi.fn().mockResolvedValue({ synchronized: 2 }) };
    const service = createService({ proxyService, sslService });

    await expect(
      service.executeTool(userWith(['admin:update']), 'resync_tls_distribution', { target: 'route', routeId: ROUTE_ID })
    ).resolves.toEqual({ result: { synchronized: true }, invalidateStores: ['proxy', 'ssl'] });
    expect(proxyService.resyncTlsHost).toHaveBeenCalledWith(ROUTE_ID, 'user-1');

    await expect(
      service.executeTool(userWith(['admin:update']), 'resync_tls_distribution', {
        target: 'certificate',
        sslCertificateId: CERT_ID,
      })
    ).resolves.toEqual({ result: { synchronized: 2 }, invalidateStores: ['proxy', 'ssl'] });
    expect(sslService.resyncDistribution).toHaveBeenCalledWith(CERT_ID, 'user-1');

    // Route-level edit rights do not grant the global repair action.
    const denied = await service.executeTool(
      userWith([`proxy:edit:${ROUTE_ID}`, `ssl:cert:issue:${CERT_ID}`]),
      'resync_tls_distribution',
      { target: 'route', routeId: ROUTE_ID }
    );
    expect(denied.error).toMatch(/PERMISSION_DENIED/);
    expect(proxyService.resyncTlsHost).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending ACME issue with per-certificate ssl:cert:issue and renews with the requester email', async () => {
    const sslService = {
      cancelPendingAcmeIssue: vi.fn().mockResolvedValue(undefined),
      renewCert: vi.fn().mockResolvedValue({ id: CERT_ID }),
    };
    const service = createService({ sslService });

    await expect(
      service.executeTool(userWith([`ssl:cert:issue:${CERT_ID}`]), 'manage_ssl_certificate', {
        operation: 'cancel_acme',
        sslCertificateId: CERT_ID,
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['ssl'] });
    expect(sslService.cancelPendingAcmeIssue).toHaveBeenCalledWith(CERT_ID, 'user-1');

    const denied = await service.executeTool(userWith([`ssl:cert:view:${CERT_ID}`]), 'manage_ssl_certificate', {
      operation: 'cancel_acme',
      sslCertificateId: CERT_ID,
    });
    expect(denied.error).toMatch(/ssl:cert:issue/);

    await service.executeTool(userWith([`ssl:cert:issue:${CERT_ID}`]), 'manage_ssl_certificate', {
      operation: 'renew',
      sslCertificateId: CERT_ID,
    });
    expect(sslService.renewCert).toHaveBeenCalledWith(CERT_ID, 'user-1', 'admin@example.com');
  });
});

describe('route enable parity', () => {
  it('enables or disables a route through the toggle lifecycle instead of the update write', async () => {
    const host = { id: ROUTE_ID, type: 'proxy', enabled: true, domainNames: ['app.example.com'] };
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue(host),
      updateProxyHost: vi.fn(),
      toggleProxyHost: vi.fn().mockResolvedValue({ ...host, enabled: false }),
      assertReferenceAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({ proxyService });

    const result = await service.executeTool(userWith([`proxy:edit:${ROUTE_ID}`]), 'update_route', {
      routeId: ROUTE_ID,
      enabled: false,
    });

    expect(result.error).toBeUndefined();
    expect(proxyService.updateProxyHost).not.toHaveBeenCalled();
    expect(proxyService.toggleProxyHost).toHaveBeenCalledWith(ROUTE_ID, false, 'user-1');
  });
});

describe('domain operational tools', () => {
  it('issues a domain certificate like the issue-cert route, including the ssl:cert:issue check', async () => {
    const domainsService = {
      getDomain: vi.fn().mockResolvedValue({ id: DOMAIN_ID, domain: 'example.com', dnsProvider: 'cloudflare' }),
    };
    const requestACMECert = vi.fn().mockResolvedValue({ id: CERT_ID });
    container.registerInstance(SSLService, { requestACMECert } as never);
    const service = createService({ domainsService });

    const denied = await service.executeTool(userWith([`domains:edit:${DOMAIN_ID}`]), 'manage_domain', {
      operation: 'issue_certificate',
      domainId: DOMAIN_ID,
    });
    expect(denied.error).toMatch(/ssl:cert:issue/);
    expect(requestACMECert).not.toHaveBeenCalled();

    await expect(
      service.executeTool(userWith([`domains:edit:${DOMAIN_ID}`, 'ssl:cert:issue']), 'manage_domain', {
        operation: 'issue_certificate',
        domainId: DOMAIN_ID,
      })
    ).resolves.toMatchObject({ result: { id: CERT_ID } });
    expect(requestACMECert).toHaveBeenCalledWith(
      {
        domains: ['example.com'],
        challengeType: 'dns-01',
        provider: 'letsencrypt',
        autoRenew: true,
        dnsProvider: 'cloudflare',
      },
      'user-1',
      'admin@example.com'
    );
  });

  it('previews and migrates domain ingress with validated target nodes', async () => {
    const domainsService = {
      previewIngressMigration: vi.fn().mockResolvedValue({ routes: 2 }),
      migrateIngress: vi.fn().mockResolvedValue({ moved: 2 }),
    };
    const service = createService({ domainsService });
    const scopes = [`domains:edit:${DOMAIN_ID}`];

    await expect(
      service.executeTool(userWith(scopes), 'manage_domain', {
        operation: 'preview_ingress_migration',
        domainId: DOMAIN_ID,
        targetNodeId: NODE_ID,
      })
    ).resolves.toMatchObject({ result: { routes: 2 } });
    expect(domainsService.previewIngressMigration).toHaveBeenCalledWith(DOMAIN_ID, { targetNodeId: NODE_ID });

    await service.executeTool(userWith(scopes), 'manage_domain', {
      operation: 'migrate_ingress',
      domainId: DOMAIN_ID,
      targetNodeId: NODE_ID,
    });
    expect(domainsService.migrateIngress).toHaveBeenCalledWith(DOMAIN_ID, { targetNodeId: NODE_ID }, 'user-1', scopes);

    const invalid = await service.executeTool(userWith(scopes), 'manage_domain', {
      operation: 'migrate_ingress',
      domainId: DOMAIN_ID,
      targetNodeId: 'not-a-uuid',
    });
    expect(invalid.error).toBeTruthy();
    expect(domainsService.migrateIngress).toHaveBeenCalledTimes(1);
  });
});

describe('Docker parity tools', () => {
  it('creates, updates, and deletes deployments with route scopes and redacted results', async () => {
    const detail = {
      id: 'dep-1',
      name: 'web',
      desiredConfig: { image: 'nginx:1', env: { SECRET: 'value' } },
      webhook: { token: 'hook-token' },
    };
    const deployments = {
      create: vi.fn().mockResolvedValue(detail),
      update: vi.fn().mockResolvedValue(detail),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(DockerDeploymentService, deployments as never);
    const service = createService({});

    const created = await service.executeTool(
      userWith(['docker:containers:create:node-1']),
      'manage_docker_deployment',
      {
        operation: 'create',
        nodeId: 'node-1',
        payload: { name: 'web', image: 'nginx:1', routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }] },
      }
    );
    expect(created.error).toBeUndefined();
    expect(deployments.create).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ name: 'web', image: 'nginx:1', drainSeconds: 30 }),
      'user-1',
      ['docker:containers:create:node-1']
    );
    // No environment or webhook scope: env and the webhook token are removed.
    expect(created.result).toMatchObject({ desiredConfig: { image: 'nginx:1' } });
    expect((created.result as any).desiredConfig.env).toBeUndefined();
    expect((created.result as any).webhook.token).not.toBe('hook-token');

    const invalid = await service.executeTool(userWith(['docker:containers:create']), 'manage_docker_deployment', {
      operation: 'create',
      nodeId: 'node-1',
      payload: { name: 'web', image: 'nginx:1', routes: [] },
    });
    expect(invalid.error).toBeTruthy();

    const deniedUpdate = await service.executeTool(
      userWith(['docker:containers:edit:node-1/other']),
      'manage_docker_deployment',
      { operation: 'update', nodeId: 'node-1', deploymentId: 'dep-1', payload: { drainSeconds: 10 } }
    );
    expect(deniedUpdate.error).toMatch(/docker:containers:edit/);

    await service.executeTool(userWith(['docker:containers:edit:node-1/dep-1']), 'manage_docker_deployment', {
      operation: 'update',
      nodeId: 'node-1',
      deploymentId: 'dep-1',
      payload: { drainSeconds: 10 },
    });
    expect(deployments.update).toHaveBeenCalledWith('node-1', 'dep-1', { drainSeconds: 10 }, 'user-1', [
      'docker:containers:edit:node-1/dep-1',
    ]);

    const deniedDelete = await service.executeTool(
      userWith(['docker:containers:edit:node-1/dep-1']),
      'manage_docker_deployment',
      { operation: 'delete', nodeId: 'node-1', deploymentId: 'dep-1' }
    );
    expect(deniedDelete.error).toMatch(/docker:containers:delete/);
    await expect(
      service.executeTool(userWith(['docker:containers:delete:node-1/dep-1']), 'manage_docker_deployment', {
        operation: 'delete',
        nodeId: 'node-1',
        deploymentId: 'dep-1',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['containers'] });
    expect(deployments.remove).toHaveBeenCalledWith('node-1', 'dep-1', 'user-1');
  });

  it('kills a container with the resolved scope identity and the Compose guard', async () => {
    const dockerService = {
      inspectContainer: vi.fn().mockResolvedValue({ scopeResourceId: 'scope-1' }),
      killContainer: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({ dockerService });

    await expect(
      service.executeTool(userWith(['docker:containers:manage:node-1/scope-1']), 'kill_docker_container', {
        nodeId: 'node-1',
        containerId: 'web',
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(assertComposeChildMutationAllowed).toHaveBeenCalledWith('node-1', 'web');
    expect(dockerService.killContainer).toHaveBeenCalledWith('node-1', 'web', 'SIGKILL', 'user-1');

    const denied = await service.executeTool(
      userWith(['docker:containers:manage:node-1/other']),
      'kill_docker_container',
      { nodeId: 'node-1', containerId: 'web', signal: 'SIGTERM' }
    );
    expect(denied.error).toMatch(/PERMISSION_DENIED/);
    expect(dockerService.killContainer).toHaveBeenCalledTimes(1);
  });

  it('applies the Compose guard to existing container lifecycle tools', async () => {
    vi.mocked(assertComposeChildMutationAllowed).mockRejectedValueOnce(new Error('COMPOSE_RESOURCE_MANAGED'));
    const dockerService = {
      inspectContainer: vi.fn().mockResolvedValue({ scopeResourceId: 'scope-1' }),
      stopContainer: vi.fn(),
    };
    const service = createService({ dockerService });

    const result = await service.executeTool(userWith(['docker:containers:manage']), 'stop_docker_container', {
      nodeId: 'node-1',
      containerId: 'compose-web-1',
    });
    expect(result.error).toBe('COMPOSE_RESOURCE_MANAGED');
    expect(dockerService.stopContainer).not.toHaveBeenCalled();
  });

  it('force-cancels a task only with docker:tasks:manage for the task node', async () => {
    const tasks = {
      get: vi.fn().mockResolvedValue({ id: 'task-1', nodeId: 'node-1', status: 'running' }),
      forceCancel: vi.fn().mockResolvedValue({ id: 'task-1', status: 'failed' }),
    };
    container.registerInstance(DockerTaskService, tasks as never);
    const service = createService({});

    const denied = await service.executeTool(userWith(['docker:tasks:manage:node-2']), 'force_cancel_docker_task', {
      taskId: 'task-1',
    });
    expect(denied.error).toMatch(/docker:tasks:manage:node-1/);
    expect(tasks.forceCancel).not.toHaveBeenCalled();

    await expect(
      service.executeTool(userWith(['docker:tasks:manage:node-1']), 'force_cancel_docker_task', { taskId: 'task-1' })
    ).resolves.toEqual({ result: { id: 'task-1', status: 'failed' }, invalidateStores: ['tasks'] });
  });
});

describe('node, alert, and update tools', () => {
  it('locks node service creation with per-node nodes:lock and schema validation', async () => {
    const nodesService = {
      updateServiceCreationLock: vi.fn().mockResolvedValue({ id: NODE_ID, serviceCreationLocked: true }),
    };
    const service = createService({ nodesService });

    const denied = await service.executeTool(userWith(['nodes:lock:other']), 'set_node_service_creation_lock', {
      nodeId: NODE_ID,
      serviceCreationLocked: true,
    });
    expect(denied.error).toMatch(/PERMISSION_DENIED/);

    await expect(
      service.executeTool(userWith([`nodes:lock:${NODE_ID}`]), 'set_node_service_creation_lock', {
        nodeId: NODE_ID,
        serviceCreationLocked: true,
      })
    ).resolves.toEqual({ result: { id: NODE_ID, serviceCreationLocked: true }, invalidateStores: ['nodes'] });
    expect(nodesService.updateServiceCreationLock).toHaveBeenCalledWith(
      NODE_ID,
      { serviceCreationLocked: true },
      'user-1'
    );
  });

  it('lists and dismisses system alerts with admin:alerts', async () => {
    const alerts = {
      getAlerts: vi.fn().mockResolvedValue([{ id: ALERT_ID, message: 'Node offline' }]),
      dismissAlert: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(AlertService, alerts as never);
    const service = createService({});

    await expect(
      service.executeTool(userWith(['admin:alerts']), 'manage_system_alerts', { operation: 'list' })
    ).resolves.toMatchObject({ result: [{ id: ALERT_ID }] });
    await expect(
      service.executeTool(userWith(['admin:alerts']), 'manage_system_alerts', {
        operation: 'dismiss',
        alertId: ALERT_ID,
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(alerts.dismissAlert).toHaveBeenCalledWith(ALERT_ID);

    const denied = await service.executeTool(userWith(['admin:audit']), 'manage_system_alerts', { operation: 'list' });
    expect(denied.error).toMatch(/PERMISSION_DENIED/);
  });

  it('runs the Relay and update recovery operations like the system routes', async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      container.registerInstance(EventBusService, { publish } as never);
      const updateService = {
        isGatewayUpdateInProgress: vi.fn().mockReturnValue(false),
        assertGatewayUpdateAllowed: vi.fn().mockResolvedValue(undefined),
        getCachedStatus: vi.fn().mockResolvedValue({
          updateAvailable: true,
          latestVersion: 'v2.0.0',
          relay: { updateAvailable: true, latestVersion: 'v1.5.0-rc.1' },
        }),
        prepareGatewayUpdate: vi.fn().mockResolvedValue({ artifact: 'gateway' }),
        acknowledgeGatewayUpdateFailure: vi.fn().mockResolvedValue(true),
        performUpdate: vi.fn().mockResolvedValue(undefined),
        prepareRelayUpdate: vi.fn().mockResolvedValue({ artifact: 'relay' }),
        startRelayUpdate: vi.fn(),
        performRelayUpdate: vi.fn().mockResolvedValue(undefined),
        completeRelayUpdate: vi.fn(),
        failRelayUpdate: vi.fn(),
        checkForUpdates: vi.fn().mockResolvedValue({}),
        abandonRelayUpdate: vi.fn().mockResolvedValue({ targetVersion: 'v1.5.0-rc.1' }),
        proceedWithoutWaiting: vi.fn().mockReturnValue(false),
      };
      container.registerInstance(UpdateService, updateService as never);
      const service = createService({});
      const admin = userWith(['admin:update']);

      await expect(
        service.executeTool(admin, 'manage_system_updates', { operation: 'perform_gateway_update', version: 'v2.0.0' })
      ).resolves.toMatchObject({ result: { status: 'updating', targetVersion: 'v2.0.0' } });
      expect(updateService.assertGatewayUpdateAllowed).toHaveBeenCalled();
      expect(updateService.acknowledgeGatewayUpdateFailure).toHaveBeenCalled();

      await expect(
        service.executeTool(admin, 'manage_system_updates', {
          operation: 'perform_relay_update',
          version: 'v1.5.0-rc.1',
        })
      ).resolves.toMatchObject({ result: { status: 'updating', targetVersion: 'v1.5.0-rc.1' } });
      expect(updateService.startRelayUpdate).toHaveBeenCalledWith('v1.5.0-rc.1');
      await vi.runAllTimersAsync();
      expect(updateService.performUpdate).toHaveBeenCalledWith('v2.0.0', { artifact: 'gateway' }, 'user-1');
      expect(updateService.performRelayUpdate).toHaveBeenCalledWith('v1.5.0-rc.1', { artifact: 'relay' }, 'user-1');
      expect(updateService.completeRelayUpdate).toHaveBeenCalled();

      const mismatch = await service.executeTool(admin, 'manage_system_updates', {
        operation: 'perform_relay_update',
        version: 'v1.4.0',
      });
      expect(mismatch.error).toMatch(/does not match/);

      await expect(
        service.executeTool(admin, 'manage_system_updates', { operation: 'abandon_relay_update' })
      ).resolves.toMatchObject({ result: { targetVersion: 'v1.5.0-rc.1' } });
      expect(updateService.abandonRelayUpdate).toHaveBeenCalledWith('user-1');

      const notWaiting = await service.executeTool(admin, 'manage_system_updates', {
        operation: 'proceed_gateway_update',
      });
      expect(notWaiting.error).toMatch(/No Gateway update is waiting/);

      await expect(
        service.executeTool(admin, 'manage_system_updates', { operation: 'acknowledge_gateway_update_failure' })
      ).resolves.toMatchObject({ result: { acknowledged: true } });

      updateService.isGatewayUpdateInProgress.mockReturnValue(true);
      const busy = await service.executeTool(admin, 'manage_system_updates', {
        operation: 'perform_gateway_update',
        version: 'v2.0.0',
      });
      expect(busy.error).toMatch(/already in progress/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MCP eligibility of the parity tools', () => {
  it('exposes the new tools to MCP callers holding the route scopes', () => {
    const names = (scopes: string[]) => listAvailableMcpTools(scopes).map((tool) => tool.name);
    expect(names(['admin:update'])).toEqual(
      expect.arrayContaining(['resync_tls_distribution', 'manage_system_updates'])
    );
    expect(names(['admin:alerts'])).toContain('manage_system_alerts');
    expect(names(['nodes:lock'])).toContain('set_node_service_creation_lock');
    expect(names(['docker:tasks:manage'])).toContain('force_cancel_docker_task');
    expect(names(['docker:containers:manage'])).toContain('kill_docker_container');
    expect(names(['docker:containers:create'])).toContain('manage_docker_deployment');
    expect(names(['docker:containers:view'])).not.toContain('manage_docker_deployment');
  });
});
