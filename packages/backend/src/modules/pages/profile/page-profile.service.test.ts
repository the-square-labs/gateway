import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { PageProfileService } from './page-profile.service.js';

const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const CERTIFICATE_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '55555555-5555-4555-8555-555555555555';

function queryChain(result: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function mockDb(selectResults: unknown[], returningResults: unknown[] = []) {
  const updateSets: unknown[] = [];
  const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
  const db = {
    $client: { connect: vi.fn().mockResolvedValue(client) },
    select: vi.fn(() => queryChain(selectResults.shift() ?? [])),
    insert: vi.fn(),
    update: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.set = vi.fn((value) => {
        updateSets.push(value);
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.returning = vi.fn(async () => returningResults.shift() ?? []);
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject);
      return chain;
    }),
  };
  return { db: db as unknown as DrizzleClient, raw: db, updateSets };
}

function selection(overrides?: { domain?: Record<string, unknown>; node?: Record<string, unknown> }) {
  return {
    domain: {
      id: DOMAIN_ID,
      domain: '*.pages.example.net',
      dnsStatus: 'valid',
      nginxNodeId: NODE_ID,
      ...overrides?.domain,
    },
    node: {
      id: NODE_ID,
      type: 'nginx',
      status: 'online',
      capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_config_v1'] },
      ...overrides?.node,
    },
    certificate: {
      id: CERTIFICATE_ID,
      status: 'active',
      notAfter: new Date(Date.now() + 86_400_000),
      domainNames: ['*.pages.example.net'],
    },
  };
}

describe('PageProfileService', () => {
  it('rejects mutations while Pages is disabled', async () => {
    const { db } = mockDb([[{ enabled: false }]]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');
    service.setLicensePolicyService({ hasFeatureForExistingRuntime: vi.fn(async () => true) } as never);

    await expect(service.requireEnabled()).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAGES_FEATURE_DISABLED',
    });
  });

  it('reports Pages disabled when the saved profile lacks the current entitlement', async () => {
    const { db, raw } = mockDb([]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');
    service.setLicensePolicyService({ hasFeatureForExistingRuntime: vi.fn(async () => false) } as never);

    await expect(service.isEnabled()).resolves.toBe(false);
    expect(raw.select).not.toHaveBeenCalled();
  });

  it('removes immutable previews on entitlement loss while retaining the Pages data model', async () => {
    const profile = {
      id: 'default',
      enabled: true,
      domainId: DOMAIN_ID,
      updatedById: 'user-1',
    };
    const domain = { id: DOMAIN_ID, domain: '*.pages.example.net' };
    const { db, updateSets } = mockDb([[profile], [domain], []]);
    const audit = { log: vi.fn(async () => true) };
    const service = new PageProfileService(db, audit as never, 'https://gateway.example.com');
    const runtime = { apply: vi.fn(), disable: vi.fn(async () => undefined) };
    service.setRuntimeAdapter(runtime);

    await service.disableForEntitlementLoss();

    expect(runtime.disable).toHaveBeenCalledWith({ domain: 'pages.example.net' });
    expect(updateSets).toContainEqual(expect.objectContaining({ enabled: false, status: 'disabled' }));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'page_profile.disable',
        details: { domainId: DOMAIN_ID, reason: 'license_entitlement_loss' },
      })
    );
  });

  it('persists Pages disabled and schedules cleanup before surfacing a daemon failure', async () => {
    const profile = {
      id: 'default',
      enabled: true,
      domainId: DOMAIN_ID,
      updatedById: 'user-1',
    };
    const domain = { id: DOMAIN_ID, domain: '*.pages.example.net' };
    const { db, updateSets } = mockDb([[profile], [domain]]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');
    service.setRuntimeAdapter({
      apply: vi.fn(),
      disable: vi.fn(async () => {
        throw new Error('daemon offline');
      }),
    });

    await expect(service.disable(null, 'license_entitlement_loss')).rejects.toThrow('daemon offline');

    expect(updateSets[0]).toEqual(expect.objectContaining({ enabled: false, status: 'disabled' }));
    expect(updateSets[1]).toEqual(
      expect.objectContaining({
        enabled: false,
        status: 'disabled',
        lastErrorCode: 'PAGES_RUNTIME_CLEANUP_PENDING',
        lastErrorMessage: 'daemon offline',
      })
    );
  });

  it('returns safe wildcard profile options with per-domain isolation state', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { db } = mockDb([
      [
        { id: DOMAIN_ID, domain: '*.pages.example.com', dnsStatus: 'valid', nginxNodeId: NODE_ID },
        { id: 'other', domain: 'not-wildcard.example.net', dnsStatus: 'valid', nginxNodeId: NODE_ID },
      ],
      [
        {
          id: NODE_ID,
          displayName: 'Ingress',
          hostname: 'nginx.example.net',
          status: 'online',
          capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_config_v1'] },
        },
      ],
      [
        {
          id: CERTIFICATE_ID,
          name: 'Pages wildcard',
          domainNames: ['*.pages.example.com'],
          status: 'active',
          notAfter: expiresAt,
        },
      ],
    ]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');

    await expect(service.getOptions()).resolves.toEqual({
      domains: [
        expect.objectContaining({
          id: DOMAIN_ID,
          isolation: expect.objectContaining({ same: true }),
        }),
      ],
      nodes: [expect.objectContaining({ id: NODE_ID, pagesCapable: true })],
      certificates: [expect.objectContaining({ id: CERTIFICATE_ID, notAfter: expiresAt.toISOString() })],
    });
  });

  it('requires an explicit override when Pages shares the Gateway registrable domain', async () => {
    const values = selection({ domain: { domain: '*.pages.example.com' } });
    values.certificate.domainNames = ['*.pages.example.com'];
    const { db, raw } = mockDb([[values.domain], [values.certificate]]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');

    await expect(
      service.configure(
        {
          enabled: true,
          domainId: DOMAIN_ID,
          nodeId: NODE_ID,
          certificateId: CERTIFICATE_ID,
          labelTemplate: '{hash}',
          acknowledgeSameRegistrableDomain: false,
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'PAGES_DOMAIN_ISOLATION_OVERRIDE_REQUIRED' });
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it('blocks replacing the wildcard domain while any Deployment remains retained', async () => {
    const values = selection();
    const { db, raw } = mockDb([
      [values.domain],
      [values.certificate],
      [{ domainId: '66666666-6666-4666-8666-666666666666' }],
      [{ retainedCount: 1 }],
    ]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');

    await expect(
      service.configure(
        {
          enabled: true,
          domainId: DOMAIN_ID,
          nodeId: NODE_ID,
          certificateId: CERTIFICATE_ID,
          labelTemplate: '{hash}',
          acknowledgeSameRegistrableDomain: false,
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'PAGES_DOMAIN_REPLACEMENT_BLOCKED', details: { retainedCount: 1 } });
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it('reconciles through Project placements when the legacy profile node lacks Pages capability', async () => {
    const values = selection({ node: { capabilities: { capabilities: [] } } });
    const profile = {
      id: 'default',
      enabled: true,
      domainId: DOMAIN_ID,
      nodeId: NODE_ID,
      certificateId: CERTIFICATE_ID,
      labelTemplate: '{hash}',
    };
    const { db, updateSets } = mockDb([
      [profile],
      [values.domain],
      [values.certificate],
      [{ id: PROJECT_ID }],
      [{ id: PROJECT_ID }],
    ]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');
    const runtime = { apply: vi.fn(), disable: vi.fn() };
    const publish = vi.fn();
    service.setRuntimeAdapter(runtime);
    service.setEventBus({ publish } as never);

    await service.reconcile();

    expect(runtime.apply).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'pages.example.net', certificateId: CERTIFICATE_ID })
    );
    expect(runtime.disable).not.toHaveBeenCalled();
    expect(updateSets).toContainEqual(expect.objectContaining({ status: 'ready', lastErrorCode: null }));
    expect(publish).toHaveBeenCalledWith(
      'pages.profile.changed',
      expect.objectContaining({ projectId: PROJECT_ID, action: 'profile.healthy' })
    );
  });

  it('stages a wildcard migration while DNS is pending without cleaning the source early', async () => {
    const profile = {
      id: 'default',
      enabled: true,
      domainId: DOMAIN_ID,
      nodeId: 'old-node',
      certificateId: CERTIFICATE_ID,
      labelTemplate: '{project}-{hash}',
      overrideSameRegistrableDomain: false,
    };
    const { db } = mockDb([[profile]]);
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');
    const configure = vi.spyOn(service, 'configure').mockResolvedValue({ status: 'ready' } as never);

    await service.migrateDomainIngress([DOMAIN_ID], NODE_ID, 'user-1');

    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ domainId: DOMAIN_ID, nodeId: NODE_ID, certificateId: CERTIFICATE_ID }),
      'user-1',
      { allowDnsPending: true, suppressPreviousNodeCleanup: true }
    );
  });

  it('assigns an immutable preview hostname only once', async () => {
    const baseRow = {
      deployment: { id: DEPLOYMENT_ID, publicSlug: 'abc123', previewHostname: null },
      project: { id: PROJECT_ID, slug: 'docs' },
      profile: { labelTemplate: '{project}-{hash}' },
      domain: { domain: '*.pages.example.net' },
    };
    const existingHostname = 'docs-abc123.pages.example.net';
    const { db, raw } = mockDb(
      [[baseRow], [{ ...baseRow, deployment: { ...baseRow.deployment, previewHostname: existingHostname } }]],
      [[{ previewHostname: existingHostname }]]
    );
    const service = new PageProfileService(db, { log: vi.fn() } as never, 'https://gateway.example.com');

    await expect(service.assignImmutableHostname(DEPLOYMENT_ID)).resolves.toBe(existingHostname);
    await expect(service.assignImmutableHostname(DEPLOYMENT_ID)).resolves.toBe(existingHostname);
    expect(raw.update).toHaveBeenCalledOnce();
  });
});
