import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { UpdateService } from '@/services/update.service.js';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [
    'license:view',
    'license:manage',
    'housekeeping:view',
    'housekeeping:run',
    'housekeeping:configure',
  ] as string[],
  isBlocked: false,
};

function createService(groupService: Record<string, unknown> = {}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    groupService as never,
    {} as never,
    {} as never
  );
}

afterEach(() => {
  container.reset();
});

describe('AIService maintenance tools', () => {
  it('reads and manages license through the license service', async () => {
    const licenseService = {
      getStatus: vi.fn().mockResolvedValue({ status: 'community' }),
      activateKey: vi.fn().mockResolvedValue({ status: 'valid' }),
      checkNow: vi.fn().mockResolvedValue({ status: 'valid' }),
      clearKey: vi.fn().mockResolvedValue({ status: 'community' }),
    };
    container.registerInstance(LicenseService, licenseService as unknown as LicenseService);
    const service = createService();

    await expect(service.executeTool(BASE_USER, 'get_license_status', {})).resolves.toEqual({
      result: { status: 'community' },
      invalidateStores: [],
    });
    await expect(
      service.executeTool(BASE_USER, 'manage_license', { operation: 'activate', licenseKey: 'WLT-GW-TEST' })
    ).resolves.toEqual({
      result: { status: 'valid' },
      invalidateStores: ['settings'],
    });
    await expect(service.executeTool(BASE_USER, 'manage_license', { operation: 'check' })).resolves.toEqual({
      result: { status: 'valid' },
      invalidateStores: ['settings'],
    });
    await expect(service.executeTool(BASE_USER, 'manage_license', { operation: 'clear' })).resolves.toEqual({
      result: { status: 'community' },
      invalidateStores: ['settings'],
    });

    expect(licenseService.activateKey).toHaveBeenCalledWith('WLT-GW-TEST');
  });

  it('routes housekeeping read, configure, and run operations with operation-level scopes', async () => {
    const updateSchedule = vi.fn();
    const housekeepingService = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true }),
      getStats: vi.fn().mockResolvedValue({ lastRun: null }),
      getRunHistory: vi.fn().mockResolvedValue([]),
      updateConfig: vi.fn().mockResolvedValue({ enabled: false }),
      runAll: vi.fn().mockResolvedValue({ success: true }),
    };
    container.registerInstance(HousekeepingService, housekeepingService as unknown as HousekeepingService);
    container.registerInstance(SchedulerService, { updateSchedule } as unknown as SchedulerService);
    const service = createService();

    await expect(service.executeTool(BASE_USER, 'manage_housekeeping', { operation: 'get_config' })).resolves.toEqual({
      result: { enabled: true },
      invalidateStores: ['settings'],
    });
    await expect(service.executeTool(BASE_USER, 'manage_housekeeping', { operation: 'get_stats' })).resolves.toEqual({
      result: { lastRun: null },
      invalidateStores: ['settings'],
    });
    await expect(service.executeTool(BASE_USER, 'manage_housekeeping', { operation: 'get_history' })).resolves.toEqual({
      result: [],
      invalidateStores: ['settings'],
    });
    await expect(
      service.executeTool(BASE_USER, 'manage_housekeeping', {
        operation: 'update_config',
        config: { enabled: false, cronExpression: '0 1 * * *' },
      })
    ).resolves.toEqual({
      result: { enabled: false },
      invalidateStores: ['settings'],
    });
    await expect(service.executeTool(BASE_USER, 'manage_housekeeping', { operation: 'run' })).resolves.toEqual({
      result: { success: true },
      invalidateStores: ['settings'],
    });

    expect(housekeepingService.updateConfig).toHaveBeenCalledWith({ enabled: false, cronExpression: '0 1 * * *' });
    expect(updateSchedule).toHaveBeenCalledWith('housekeeping', '0 1 * * *');
    expect(housekeepingService.runAll).toHaveBeenCalledWith('manual', BASE_USER.id);
  });

  it('rejects housekeeping mutations without operation-specific scopes', async () => {
    container.registerInstance(HousekeepingService, {
      updateConfig: vi.fn(),
      runAll: vi.fn(),
    } as unknown as HousekeepingService);
    const service = createService();
    const user = { ...BASE_USER, scopes: ['housekeeping:view'] };

    await expect(
      service.executeTool(user, 'manage_housekeeping', { operation: 'update_config', config: { enabled: false } })
    ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope housekeeping:configure' });
    await expect(service.executeTool(user, 'manage_housekeeping', { operation: 'run' })).resolves.toMatchObject({
      error: 'PERMISSION_DENIED: Missing required scope housekeeping:run',
    });
  });

  it('reads and updates gateway settings with default group privilege boundaries', async () => {
    const authSettingsService = {
      getConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: '00000000-0000-4000-8000-000000000001',
      }),
      updateConfig: vi.fn().mockResolvedValue({
        oidcAutoCreateUsers: false,
        oidcDefaultGroupId: '00000000-0000-4000-8000-000000000001',
      }),
    };
    const mcpSettingsService = {
      getConfig: vi.fn().mockResolvedValue({ serverEnabled: false, extendedCompatibility: false }),
      updateConfig: vi.fn().mockResolvedValue({ serverEnabled: true, extendedCompatibility: true }),
    };
    const generalSettingsService = {
      getConfig: vi.fn().mockResolvedValue({
        features: { pkiEnabled: true, domainsEnabled: true, inferenceEnabled: true },
      }),
      updateConfig: vi.fn().mockResolvedValue({ features: { pkiEnabled: false, domainsEnabled: true } }),
    };
    const networkSettingsService = {
      getConfig: vi.fn().mockResolvedValue({ clientIpSource: 'auto', trustedProxyCidrs: [] }),
      updateConfig: vi.fn().mockResolvedValue({ clientIpSource: 'direct', trustedProxyCidrs: [] }),
    };
    const outboundWebhookPolicyService = {
      getConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: true }),
      updateConfig: vi.fn().mockResolvedValue({ allowPrivateNetworks: false }),
    };
    const groupService = {
      getGroup: vi.fn().mockResolvedValue({ id: 'group-viewer', scopes: ['license:view'], inheritedScopes: [] }),
      listGroups: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'viewer',
          scopes: ['license:view'],
          inheritedScopes: [],
          isBuiltin: true,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'admin',
          scopes: ['admin:system'],
          inheritedScopes: [],
          isBuiltin: true,
        },
      ]),
    };
    container.registerInstance(AuthSettingsService, authSettingsService as unknown as AuthSettingsService);
    container.registerInstance(McpSettingsService, mcpSettingsService as unknown as McpSettingsService);
    container.registerInstance(GeneralSettingsService, generalSettingsService as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, networkSettingsService as unknown as NetworkSettingsService);
    container.registerInstance(
      OutboundWebhookPolicyService,
      outboundWebhookPolicyService as unknown as OutboundWebhookPolicyService
    );
    const service = createService(groupService);
    const user = { ...BASE_USER, scopes: [...BASE_USER.scopes, 'settings:gateway:edit', 'license:view'] };

    await expect(service.executeTool(user, 'get_gateway_settings', {})).resolves.toMatchObject({
      result: {
        oidcAutoCreateUsers: true,
        mcpServerEnabled: false,
        mcpExtendedCompatibility: false,
        generalSettings: {
          features: { inferenceEnabled: true },
        },
        availableGroups: [{ id: '00000000-0000-4000-8000-000000000001', name: 'viewer', isBuiltin: true }],
      },
      invalidateStores: [],
    });

    await expect(
      service.executeTool(user, 'update_gateway_settings', {
        oidcAutoCreateUsers: false,
        oidcDefaultGroupId: '00000000-0000-4000-8000-000000000001',
        mcpServerEnabled: true,
        mcpExtendedCompatibility: true,
        generalSettings: { features: { pkiEnabled: false } },
        networkSecurity: { clientIpSource: 'direct' },
        outboundWebhookPolicy: { allowPrivateNetworks: false },
      })
    ).resolves.toMatchObject({
      result: {
        oidcAutoCreateUsers: false,
        mcpServerEnabled: true,
        mcpExtendedCompatibility: true,
        availableGroups: [{ id: '00000000-0000-4000-8000-000000000001', name: 'viewer', isBuiltin: true }],
      },
      invalidateStores: ['settings'],
    });

    expect(authSettingsService.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        oidcAutoCreateUsers: false,
        oidcDefaultGroupId: '00000000-0000-4000-8000-000000000001',
      })
    );
    expect(mcpSettingsService.updateConfig).toHaveBeenCalledWith({
      serverEnabled: true,
      extendedCompatibility: true,
    });
    expect(generalSettingsService.updateConfig).toHaveBeenCalledWith({ features: { pkiEnabled: false } });
    expect(networkSettingsService.updateConfig).toHaveBeenCalledWith({ clientIpSource: 'direct' });
    expect(outboundWebhookPolicyService.updateConfig).toHaveBeenCalledWith({ allowPrivateNetworks: false });
  });

  it('routes gateway and daemon update operations through update services', async () => {
    const updateService = {
      getCachedStatus: vi.fn().mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
      }),
      checkForUpdates: vi.fn().mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.1.0' }),
      getReleaseNotes: vi.fn().mockResolvedValue('release notes'),
    };
    const daemonUpdateService = {
      getCachedStatus: vi.fn().mockResolvedValue([{ daemonType: 'docker', nodes: [] }]),
      checkForUpdates: vi.fn().mockResolvedValue([{ daemonType: 'docker', checked: true }]),
      getLatestRelease: vi.fn().mockResolvedValue({ tagName: 'v1.1.0-docker', version: 'v1.1.0' }),
      prepareTrustedDaemonUpdate: vi.fn().mockResolvedValue({
        downloadUrl: 'https://example.test/docker',
        checksum: 'sha256:test',
        signedManifest: 'signed',
      }),
      markNodeUpdateInProgress: vi.fn().mockResolvedValue(undefined),
      clearNodeUpdateInProgress: vi.fn().mockResolvedValue(undefined),
      trackNodeUpdateCompletion: vi.fn(),
    };
    const completion = new Promise<never>(() => {});
    const nodeDispatchService = {
      sendUpdateDaemonCommand: vi.fn().mockResolvedValue({
        accepted: Promise.resolve(),
        result: completion,
      }),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi
              .fn()
              .mockResolvedValue([{ id: 'node-1', type: 'docker', capabilities: { architecture: 'amd64' } }]),
          })),
        })),
      })),
    };
    container.registerInstance(UpdateService, updateService as unknown as UpdateService);
    container.registerInstance(DaemonUpdateService, daemonUpdateService as unknown as DaemonUpdateService);
    container.registerInstance(NodeDispatchService, nodeDispatchService as unknown as NodeDispatchService);
    container.registerInstance(TOKENS.DrizzleClient, db);
    const service = createService();
    const user = { ...BASE_USER, scopes: [...BASE_USER.scopes, 'admin:update'] };

    await expect(
      service.executeTool(user, 'manage_system_updates', { operation: 'get_gateway_status' })
    ).resolves.toEqual({
      result: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
      invalidateStores: ['settings', 'nodes'],
    });
    await expect(service.executeTool(user, 'manage_system_updates', { operation: 'check_gateway' })).resolves.toEqual({
      result: { currentVersion: '1.0.0', latestVersion: '1.1.0' },
      invalidateStores: ['settings', 'nodes'],
    });
    await expect(
      service.executeTool(user, 'manage_system_updates', { operation: 'get_gateway_release_notes', version: 'v1.1.0' })
    ).resolves.toEqual({
      result: { version: 'v1.1.0', notes: 'release notes' },
      invalidateStores: ['settings', 'nodes'],
    });
    await expect(
      service.executeTool(user, 'manage_system_updates', { operation: 'list_daemon_updates' })
    ).resolves.toEqual({
      result: [{ daemonType: 'docker', nodes: [] }],
      invalidateStores: ['settings', 'nodes'],
    });
    await expect(
      service.executeTool(user, 'manage_system_updates', { operation: 'check_daemon_updates' })
    ).resolves.toEqual({
      result: [{ daemonType: 'docker', checked: true }],
      invalidateStores: ['settings', 'nodes'],
    });
    await expect(
      service.executeTool(user, 'manage_system_updates', { operation: 'update_daemon', nodeId: 'node-1' })
    ).resolves.toEqual({
      result: { scheduled: true, targetVersion: 'v1.1.0' },
      invalidateStores: ['settings', 'nodes'],
    });

    expect(nodeDispatchService.sendUpdateDaemonCommand).toHaveBeenCalledWith(
      'node-1',
      'https://example.test/docker',
      'v1.1.0',
      'sha256:test',
      'signed'
    );
    expect(daemonUpdateService.trackNodeUpdateCompletion).toHaveBeenCalledWith('node-1', completion);
  });
});
