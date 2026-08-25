import { describe, expect, it, vi } from 'vitest';
import { UIBootstrapService } from './ui-bootstrap.service.js';

const nodeSnapshot = {
  data: [
    {
      id: 'node-nginx',
      type: 'nginx',
      status: 'online',
      isConnected: true,
      capabilities: {},
    },
    {
      id: 'node-docker',
      type: 'docker',
      status: 'online',
      isConnected: true,
      capabilities: {},
    },
    {
      id: 'node-offline',
      type: 'docker',
      status: 'offline',
      isConnected: false,
      capabilities: {},
    },
  ],
  revision: 1,
  observedAt: '2026-08-07T00:00:00.000Z',
  lastAttemptAt: '2026-08-07T00:00:00.000Z',
  lastError: null,
  refreshStatus: 'success' as const,
  availability: 'available' as const,
};

const configData = {
  publicUrl: 'https://gateway.example.com',
  fileUploadMaxBytes: 1,
  fileOpenMaxBytes: 2,
  gatewayGrpcPublicTarget: null,
  gatewayGrpcLocalIp: null,
  relayAutoRecovery: false,
  features: { pkiEnabled: true, domainsEnabled: true, siemEnabled: true, inferenceEnabled: true },
};

const configSnapshot = { ...nodeSnapshot, data: configData };
const statusPageSnapshot = { ...nodeSnapshot, data: { enabled: true } };
const cloudflareSnapshot = { ...nodeSnapshot, data: true };
const license = {
  status: 'active' as const,
  plan: 'personal' as const,
  licensed: true,
  expiresAt: null,
  graceUntil: null,
  offlineGraceUntil: null,
  entitlementsVersion: 2,
  entitlements: {
    managedNodes: 100,
    users: 10,
    customPermissionGroups: 5,
    supportLevel: 'personal',
    features: ['infrastructure', 'pages'],
  },
};

function makeService() {
  const snapshots = {
    get: vi.fn(async (kind: string) => {
      if (kind === 'ui-shell-config') return configSnapshot;
      if (kind === 'ui-shell-status-page') return statusPageSnapshot;
      if (kind === 'ui-shell-cloudflare') return cloudflareSnapshot;
      return nodeSnapshot;
    }),
  };
  const coordinator = { register: vi.fn(), enqueue: vi.fn() };
  const nodes = { list: vi.fn() };
  const settings = {
    getConfig: vi.fn(async () => configData),
  };
  const loggingFeature = { isEnabled: vi.fn(() => true) };
  const integrations = { hasEnabledCloudflareConnector: vi.fn(async () => true) };
  const statusPage = { getConfig: vi.fn(async () => ({ enabled: true })) };
  const updates = { getCachedStatus: vi.fn(async () => ({ updateAvailable: false })) };
  const aiRuntime = { statusForUser: vi.fn(async () => ({ enabled: true })) };
  const aiSettings = { isEnabled: vi.fn(async () => true) };
  const finalizeSetup = { isOwner: vi.fn(async () => false) };
  const licensePolicy = { getSummary: vi.fn(async () => license) };
  const pageProfile = { isEnabled: vi.fn(async () => true) };
  return {
    service: new UIBootstrapService(
      snapshots as never,
      coordinator as never,
      nodes as never,
      settings as never,
      loggingFeature as never,
      integrations as never,
      statusPage as never,
      updates as never,
      aiRuntime as never,
      aiSettings as never,
      finalizeSetup as never,
      licensePolicy as never,
      pageProfile as never
    ),
    coordinator,
    updates,
    aiRuntime,
    statusPage,
    integrations,
    licensePolicy,
  };
}

describe('UIBootstrapService', () => {
  it('builds a permission-filtered shell from the existing node read model', async () => {
    const { service, coordinator, updates, aiRuntime, statusPage, integrations } = makeService();
    const scopes = [
      'nodes:details:node-nginx',
      'docker:containers:view:node-docker',
      'ai:workspace:use',
      'status-page:view',
      'pages:view',
    ];

    const shell = await service.getShell({ id: 'user-1', scopes } as never, scopes);

    expect(coordinator.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ui-shell:nodes', fallbackIntervalMs: 10_000 })
    );
    expect(shell.navigation.hasNginxNodes).toBe(true);
    expect(shell.navigation.hasCloudflareIntegration).toBe(true);
    expect(shell.navigation.statusPageEnabled).toBe(true);
    expect(shell.navigation.pagesEnabled).toBe(true);
    expect(shell.navigation.nodes.data.map((node) => node.id)).toEqual(['node-nginx']);
    expect(shell.navigation.dockerNodes.map((node) => node.id)).toEqual(['node-docker']);
    expect(shell.systemConfig.publicUrl).toBe('https://gateway.example.com');
    expect(shell.systemConfig.features).toEqual({
      pkiEnabled: true,
      domainsEnabled: true,
      siemEnabled: true,
      loggingEnabled: true,
      inferenceEnabled: true,
    });
    expect(shell.license).toEqual(license);
    expect(updates.getCachedStatus).not.toHaveBeenCalled();
    expect(aiRuntime.statusForUser).toHaveBeenCalledOnce();
    expect(statusPage.getConfig).not.toHaveBeenCalled();
    expect(integrations.hasEnabledCloudflareConnector).not.toHaveBeenCalled();
  });

  it('does not expose shell data for unavailable resource scopes', async () => {
    const { service, updates, aiRuntime } = makeService();
    const shell = await service.getShell({ id: 'user-1', scopes: [] } as never, []);

    expect(shell.navigation.hasNginxNodes).toBe(true);
    expect(shell.navigation.hasCloudflareIntegration).toBe(true);
    expect(shell.navigation.statusPageEnabled).toBe(false);
    expect(shell.navigation.pagesEnabled).toBe(false);
    expect(shell.navigation.dockerNodes).toEqual([]);
    expect(updates.getCachedStatus).not.toHaveBeenCalled();
    expect(aiRuntime.statusForUser).not.toHaveBeenCalled();
  });

  it('hides Pages navigation when the persisted profile is enabled without the entitlement', async () => {
    const { service, licensePolicy } = makeService();
    licensePolicy.getSummary.mockResolvedValue({
      ...license,
      status: 'community',
      plan: 'community',
      entitlements: {
        ...license.entitlements,
        supportLevel: 'community',
        features: ['infrastructure'],
      },
    } as never);

    const shell = await service.getShell({ id: 'user-1', scopes: ['pages:view'] } as never, ['pages:view']);

    expect(shell.navigation.pagesEnabled).toBe(false);
  });

  it('rebuilds a cold shell from safe persisted sources without waiting for managed resources', async () => {
    const snapshots = {
      get: vi.fn(async () => null),
      withLease: vi.fn(async (_kind: string, _id: string, loader: () => Promise<unknown>) => ({
        acquired: true,
        value: await loader(),
      })),
      markRefreshing: vi.fn(async () => undefined),
      replace: vi.fn(async (_kind: string, _id: string, data: unknown) => ({ ...nodeSnapshot, data })),
      markError: vi.fn(),
    };
    const coordinator = { register: vi.fn(), enqueue: vi.fn() };
    const nodes = { list: vi.fn(async () => ({ data: nodeSnapshot.data })) };
    const settings = { getConfig: vi.fn(async () => configData) };
    const loggingFeature = { isEnabled: vi.fn(() => true) };
    const integrations = { hasEnabledCloudflareConnector: vi.fn(async () => false) };
    const statusPage = { getConfig: vi.fn(async () => ({ enabled: true })) };
    const updates = { getCachedStatus: vi.fn() };
    const aiRuntime = { statusForUser: vi.fn() };
    const aiSettings = { isEnabled: vi.fn(async () => false) };
    const finalizeSetup = { isOwner: vi.fn(async () => false) };
    const licensePolicy = { getSummary: vi.fn(async () => license) };
    const service = new UIBootstrapService(
      snapshots as never,
      coordinator as never,
      nodes as never,
      settings as never,
      loggingFeature as never,
      integrations as never,
      statusPage as never,
      updates as never,
      aiRuntime as never,
      aiSettings as never,
      finalizeSetup as never,
      licensePolicy as never
    );

    const shell = await service.getShell(
      { id: 'user-1', scopes: ['nodes:details:node-nginx', 'status-page:view'] } as never,
      ['nodes:details:node-nginx', 'status-page:view']
    );

    expect(nodes.list).toHaveBeenCalledWith({ page: 1, limit: 1_000 });
    expect(settings.getConfig).toHaveBeenCalledOnce();
    expect(statusPage.getConfig).toHaveBeenCalledOnce();
    expect(shell.navigation.nodes.data.map((node) => node.id)).toEqual(['node-nginx']);
    expect(shell.navigation.hasCloudflareIntegration).toBe(false);
    expect(integrations.hasEnabledCloudflareConnector).toHaveBeenCalledOnce();
    expect(shell.navigation.statusPageEnabled).toBe(true);
    expect(coordinator.enqueue).not.toHaveBeenCalled();
    expect(updates.getCachedStatus).not.toHaveBeenCalled();
    expect(aiRuntime.statusForUser).not.toHaveBeenCalled();
  });
});
