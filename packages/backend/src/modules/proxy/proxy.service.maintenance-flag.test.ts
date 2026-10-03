// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { MAINTENANCE_FLAG_CAPABILITY, MAINTENANCE_FLAG_DIR } from './nginx-maintenance-flag-guard.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { ProxyService } from './proxy.service.js';

const HOST_ID = '22222222-2222-4222-8222-222222222222';

function route(maintenanceEnabled: boolean) {
  return {
    id: HOST_ID,
    type: 'proxy',
    domainNames: ['shop.example.com'],
    enabled: true,
    isSystem: false,
    nodeId: 'nginx-node',
    ingressGroupId: null,
    upstreamKind: 'manual',
    dockerNodeId: null,
    dockerDeploymentId: null,
    forwardHost: '10.0.0.5',
    forwardPort: 8080,
    forwardScheme: 'http',
    secureLinkGeneration: 0,
    secureLinkMigratedAt: null,
    sslEnabled: false,
    sslForced: false,
    http2Support: false,
    websocketSupport: false,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    nginxTemplateId: null,
    templateVariables: {},
    maintenanceEnabled,
    maintenanceStartedAt: maintenanceEnabled ? new Date('2026-10-01T00:00:00Z') : null,
    healthCheckEnabled: false,
    healthStatus: 'unknown',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  } as any;
}

/** A maintenance toggle over fakes: the stored row before and after, and a node reporting `capabilities`. */
function toggleHarness(before: any, after: any, capabilities: string[]) {
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn().mockResolvedValue(before) },
      nodes: {
        findFirst: vi.fn().mockResolvedValue({ type: 'nginx', status: 'online', capabilities: { capabilities } }),
      },
      nginxTemplates: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([after]) })) })),
    })),
  } as any;
  const applyConfig = vi.fn().mockResolvedValue({ success: true });
  const maintenanceAccess = {
    secretForHost: () => 'route-secret',
    isNodeSupported: vi.fn().mockResolvedValue(true),
  } as any;
  const service = new ProxyService(
    db,
    new NginxTemplateService(db, {} as never, new ConfigValidatorService()),
    { log: vi.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    maintenanceAccess
  );
  return { service, applyConfig };
}

describe('Maintenance mode on a node that keeps maintenance flags', () => {
  it('switches only the flag: entering and leaving send the route config unchanged', async () => {
    const enter = toggleHarness(route(false), route(true), [
      'proxy_maintenance_access_v1',
      MAINTENANCE_FLAG_CAPABILITY,
    ]);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');
    const leave = toggleHarness(route(true), route(false), [
      'proxy_maintenance_access_v1',
      MAINTENANCE_FLAG_CAPABILITY,
    ]);
    await leave.service.toggleMaintenance(HOST_ID, false, 'user-id');

    const [entered] = enter.applyConfig.mock.calls;
    const [left] = leave.applyConfig.mock.calls;
    expect(entered![2]).toBe(left![2]);
    expect(entered![2]).toContain(`if (-f ${MAINTENANCE_FLAG_DIR}/${HOST_ID})`);
    // (node, host, config, testOnly, ownership, deferReload, maintenance)
    expect(entered![6]).toBe(true);
    expect(left![6]).toBe(false);
  });

  it('keeps reloading on a node without maintenance flags', async () => {
    const enter = toggleHarness(route(false), route(true), ['proxy_maintenance_access_v1']);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');
    const leave = toggleHarness(route(true), route(false), ['proxy_maintenance_access_v1']);
    await leave.service.toggleMaintenance(HOST_ID, false, 'user-id');

    const [entered] = enter.applyConfig.mock.calls;
    const [left] = leave.applyConfig.mock.calls;
    expect(entered![2]).toContain('return 503');
    expect(left![2]).not.toContain('return 503');
    expect(entered![6]).toBeUndefined();
    expect(left![6]).toBeUndefined();
  });
});
