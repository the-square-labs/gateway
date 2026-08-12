import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { ProxyService } from './proxy.service.js';

vi.mock('@/db/schema/access-lists.js', () => ({ accessLists: { id: 'access_lists.id' } }));
vi.mock('@/db/schema/certificates.js', () => ({ certificates: { id: 'certificates.id' } }));
vi.mock('@/db/schema/ssl-certificates.js', () => ({ sslCertificates: { id: 'ssl_certificates.id' } }));
vi.mock('@/db/schema/index.js', () => ({
  proxyHosts: {
    id: 'proxy_hosts.id',
    isSystem: 'proxy_hosts.is_system',
    enabled: 'proxy_hosts.enabled',
    maintenanceEnabled: 'proxy_hosts.maintenance_enabled',
    healthCheckEnabled: 'proxy_hosts.health_check_enabled',
  },
}));

function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'proxy',
    domainNames: ['example.com'],
    slug: 'example-com',
    enabled: true,
    maintenanceEnabled: false,
    maintenanceStartedAt: null,
    upstreamKind: 'manual',
    forwardHost: '10.0.0.2',
    forwardPort: 8080,
    forwardScheme: 'http',
    dockerNodeId: null,
    dockerContainerName: null,
    dockerDeploymentId: null,
    dockerContainerPort: null,
    dockerHostPort: null,
    dockerProtocol: null,
    sslEnabled: false,
    sslForced: false,
    http2Support: true,
    sslCertificateId: null,
    internalCertificateId: null,
    websocketSupport: true,
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
    folderId: null,
    sortOrder: 0,
    nginxTemplateId: null,
    templateVariables: {},
    accessListId: null,
    nodeId: '22222222-2222-4222-8222-222222222222',
    healthCheckEnabled: true,
    healthCheckUrl: '/',
    healthCheckInterval: 30,
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: 'includes',
    healthCheckSlowThreshold: 3,
    healthStatus: 'online',
    lastHealthCheckAt: null,
    healthHistory: [],
    isSystem: false,
    systemKind: null,
    createdById: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function setup(
  applyResult: { success: boolean; error?: string },
  existingOverrides: Record<string, unknown> = {},
  updatedOverrides: Record<string, unknown> = {}
) {
  const existing = makeHost(existingOverrides);
  const updated = makeHost({
    ...existingOverrides,
    maintenanceEnabled: true,
    maintenanceStartedAt: new Date(),
    ...updatedOverrides,
  });
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) },
      sslCertificates: { findFirst: vi.fn() },
      certificates: { findFirst: vi.fn() },
      accessLists: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        writes.push(data);
        return {
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })),
        };
      }),
    })),
  } as any;
  const nginxTemplateService = {
    renderForHost: vi.fn().mockReturnValue('normal config'),
    applyMaintenanceGuard: vi.fn().mockReturnValue('maintenance config'),
  } as any;
  const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any;
  const configGenerator = {
    validateAdvancedConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    getCertPaths: vi.fn((certId: string) => ({
      certPath: `/etc/nginx/certs/${certId}/fullchain.pem`,
      keyPath: `/etc/nginx/certs/${certId}/privkey.pem`,
      chainPath: `/etc/nginx/certs/${certId}/chain.pem`,
    })),
  } as any;
  const nodeDispatch = {
    resolveNodeId: vi.fn().mockResolvedValue(existing.nodeId),
    applyConfig: vi.fn().mockResolvedValue(applyResult),
  } as any;
  const certificateDistribution = {
    supportsNode: vi.fn().mockResolvedValue(false),
    legacyPathsForHost: vi.fn(
      async (host: { sslCertificateId?: string | null; internalCertificateId?: string | null }) => {
        const certId = host.sslCertificateId ?? `internal-${host.internalCertificateId}`;
        return {
          sslCertPath: `/etc/nginx/certs/${certId}/fullchain.pem`,
          sslKeyPath: `/etc/nginx/certs/${certId}/privkey.pem`,
          sslChainPath: null,
        };
      }
    ),
  } as any;
  const service = new ProxyService(
    db,
    nginxTemplateService,
    auditService,
    configGenerator,
    nodeDispatch,
    certificateDistribution
  );
  return {
    service,
    existing,
    writes,
    db,
    nginxTemplateService,
    auditService,
    configGenerator,
    nodeDispatch,
    certificateDistribution,
  };
}

describe('ProxyService maintenance lifecycle', () => {
  it('persists and applies the dedicated maintenance config before emitting the transition', async () => {
    const { service, nginxTemplateService, nodeDispatch, auditService } = setup({ success: true });
    const result = await service.toggleMaintenance(
      '11111111-1111-4111-8111-111111111111',
      true,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(result.maintenanceEnabled).toBe(true);
    expect(nginxTemplateService.renderForHost).toHaveBeenCalledOnce();
    expect(nginxTemplateService.applyMaintenanceGuard).toHaveBeenCalledWith('normal config', undefined, false);
    expect(nodeDispatch.applyConfig).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'maintenance config',
      false,
      'user_owned'
    );
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'proxy_host.maintenance_enter' }));
  });

  it('rolls maintenance state back and emits no transition when config apply fails', async () => {
    const { service, writes, auditService, nginxTemplateService, nodeDispatch } = setup({
      success: false,
      error: 'reload failed',
    });

    await expect(
      service.toggleMaintenance('11111111-1111-4111-8111-111111111111', true, '33333333-3333-4333-8333-333333333333')
    ).rejects.toMatchObject({ code: 'NGINX_CONFIG_FAILED' });

    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ maintenanceEnabled: false, maintenanceStartedAt: null, healthStatus: 'online' });
    expect(nginxTemplateService.renderForHost).toHaveBeenCalledTimes(2);
    expect(nodeDispatch.applyConfig).toHaveBeenNthCalledWith(
      2,
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'normal config',
      false,
      'user_owned'
    );
    expect(auditService.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'proxy_host.maintenance_enter' })
    );
  });

  it('keeps HTTPS paths for an already-deployed legacy certificate during maintenance', async () => {
    const certificateId = '44444444-4444-4444-8444-444444444444';
    const { service, nginxTemplateService, certificateDistribution } = setup(
      { success: true },
      { sslEnabled: true, sslForced: true, sslCertificateId: certificateId }
    );

    await service.toggleMaintenance(
      '11111111-1111-4111-8111-111111111111',
      true,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(certificateDistribution.legacyPathsForHost).toHaveBeenCalledWith(
      expect.objectContaining({ sslCertificateId: certificateId })
    );
    expect(nginxTemplateService.renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({
        sslEnabled: true,
        sslCertPath: `/etc/nginx/certs/${certificateId}/fullchain.pem`,
        sslKeyPath: `/etc/nginx/certs/${certificateId}/privkey.pem`,
      }),
      null,
      false
    );
    expect(nginxTemplateService.applyMaintenanceGuard).toHaveBeenCalledWith('normal config', undefined, false);
  });

  it('rejects maintenance for disabled or unmanaged proxy hosts', async () => {
    const disabled = setup({ success: true }, { enabled: false });
    await expect(
      disabled.service.toggleMaintenance(
        '11111111-1111-4111-8111-111111111111',
        true,
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'MAINTENANCE_HOST_DISABLED' });

    const raw = setup({ success: true }, { rawConfigEnabled: true });
    await expect(
      raw.service.toggleMaintenance(
        '11111111-1111-4111-8111-111111111111',
        true,
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'MAINTENANCE_UNSUPPORTED_HOST' });
  });

  it('validates stored raw config before an update newly enables raw mode', async () => {
    const { service, configGenerator, db } = setup(
      { success: true },
      { rawConfig: 'include /etc/nginx/conf.d/private.conf;' }
    );
    configGenerator.validateAdvancedConfig.mockReturnValue({ valid: false, errors: ['forbidden include'] });

    await expect(
      service.updateProxyHost(
        '11111111-1111-4111-8111-111111111111',
        { rawConfigEnabled: true },
        '33333333-3333-4333-8333-333333333333',
        { bypassRawValidation: false }
      )
    ).rejects.toMatchObject({ code: 'INVALID_RAW_CONFIG' });

    expect(configGenerator.validateAdvancedConfig).toHaveBeenCalledWith(
      'include /etc/nginx/conf.d/private.conf;',
      true,
      false
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it('preserves the scoped raw-validation bypass when enabling stored raw config', async () => {
    const rawConfig = 'include /etc/nginx/conf.d/private.conf;';
    const { service, configGenerator } = setup({ success: true }, { rawConfig }, { rawConfig, rawConfigEnabled: true });

    await service.updateProxyHost(
      '11111111-1111-4111-8111-111111111111',
      { rawConfigEnabled: true },
      '33333333-3333-4333-8333-333333333333',
      { bypassRawValidation: true }
    );

    expect(configGenerator.validateAdvancedConfig).toHaveBeenCalledWith(rawConfig, true, true);
  });

  it('is idempotent when the requested maintenance state is already active', async () => {
    const { service, nodeDispatch, writes } = setup(
      { success: true },
      { maintenanceEnabled: true, maintenanceStartedAt: new Date() }
    );

    const result = await service.toggleMaintenance(
      '11111111-1111-4111-8111-111111111111',
      true,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(result.maintenanceEnabled).toBe(true);
    expect(writes).toHaveLength(0);
    expect(nodeDispatch.applyConfig).not.toHaveBeenCalled();
  });

  it('keeps an existing HTTPS host editable on an old daemon when a full-form update leaves TLS unchanged', async () => {
    const certificateId = '44444444-4444-4444-8444-444444444444';
    const existing = makeHost({ sslEnabled: true, sslForced: true, sslCertificateId: certificateId });
    const updated = makeHost({ ...existing, forwardPort: 8081, updatedAt: new Date() });
    const db = {
      query: {
        proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) },
        accessLists: { findFirst: vi.fn() },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
    } as any;
    const certificateDistribution = {
      supportsNode: vi.fn().mockResolvedValue(false),
      legacyPathsForHost: vi.fn().mockResolvedValue({
        sslCertPath: `/etc/nginx/certs/${certificateId}/fullchain.pem`,
        sslKeyPath: `/etc/nginx/certs/${certificateId}/privkey.pem`,
        sslChainPath: null,
      }),
      prepareForHost: vi.fn().mockRejectedValue(new Error('v2 must not be required for unchanged TLS')),
    } as any;
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockReturnValue('updated config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {
        resolveNodeId: vi.fn().mockResolvedValue(existing.nodeId),
        applyConfig: vi.fn().mockResolvedValue({ success: true }),
      } as any,
      certificateDistribution
    );

    await service.updateProxyHost(
      existing.id,
      { forwardPort: 8081, sslEnabled: true, sslCertificateId: certificateId } as any,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(certificateDistribution.legacyPathsForHost).toHaveBeenCalledOnce();
    expect(certificateDistribution.prepareForHost).not.toHaveBeenCalled();
  });

  it('returns the explicit daemon-update error when an old daemon receives a changed TLS reference', async () => {
    const oldCertificateId = '44444444-4444-4444-8444-444444444444';
    const newCertificateId = '55555555-5555-4555-8555-555555555555';
    const existing = makeHost({ sslEnabled: true, sslForced: true, sslCertificateId: oldCertificateId });
    const updated = makeHost({ ...existing, sslCertificateId: newCertificateId, updatedAt: new Date() });
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
    } as any;
    const daemonUpdateRequired = new AppError(
      409,
      'NGINX_TLS_DAEMON_UPDATE_REQUIRED',
      'Update the selected Nginx daemon before changing this TLS proxy host'
    );
    const certificateDistribution = {
      supportsNode: vi.fn().mockResolvedValue(false),
      prepareForHost: vi.fn().mockRejectedValue(daemonUpdateRequired),
      legacyPathsForHost: vi.fn(),
    } as any;
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn() } as any,
      { log: vi.fn() } as any,
      {} as any,
      {} as any,
      certificateDistribution
    );

    await expect(
      service.updateProxyHost(
        existing.id,
        { sslCertificateId: newCertificateId } as any,
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'NGINX_TLS_DAEMON_UPDATE_REQUIRED', statusCode: 409 });
    expect(certificateDistribution.prepareForHost).toHaveBeenCalledOnce();
  });
});
