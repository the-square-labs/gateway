import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { AIService } from './ai.service.js';
import { getOpenAITools, parseAndValidateAIToolArguments } from './ai.tools.js';
import { isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

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

function createService({
  auditService = { log: vi.fn() },
  monitoringService = {},
  nodesService = {},
}: {
  auditService?: Record<string, unknown>;
  monitoringService?: Record<string, unknown>;
  nodesService?: Record<string, unknown>;
} = {}) {
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
    auditService as never,
    monitoringService as never,
    nodesService as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function toolNames(scopes: string[]) {
  return getOpenAITools([], scopes, false).map((tool) => tool.function.name);
}

afterEach(() => {
  container.reset();
  vi.restoreAllMocks();
});

describe('manage_relay_pool', () => {
  function registerRelayServices() {
    const relaySupervisor = {
      getSnapshot: vi.fn().mockReturnValue({ status: 'healthy', admin: true }),
      retryRecovery: vi.fn().mockResolvedValue({ status: 'recovering' }),
    };
    const relayPool = {
      getSnapshot: vi.fn().mockResolvedValue({ instances: [{ id: INSTANCE_ID, draining: false }] }),
      issueRelayReenrollment: vi.fn().mockResolvedValue({
        enrollmentToken: 'gw_enroll_relay',
        installCommand: 'curl ... | sh',
      }),
      stageRebalance: vi.fn().mockResolvedValue([{ state: 'staging' }]),
      drainInstance: vi.fn().mockResolvedValue(undefined),
      forceDisconnectInstance: vi.fn().mockResolvedValue(undefined),
      renewInstanceCertificate: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(RelaySupervisorService, relaySupervisor as unknown as RelaySupervisorService);
    container.registerInstance(RelayPoolService, relayPool as unknown as RelayPoolService);
    return { relaySupervisor, relayPool };
  }

  it('reads the pool like GET /system/relay with settings:gateway:view', async () => {
    const { relaySupervisor } = registerRelayServices();
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:view'] }, 'manage_relay_pool', {
        operation: 'get',
      })
    ).resolves.toEqual({
      result: {
        status: 'healthy',
        admin: true,
        instances: [{ id: INSTANCE_ID, draining: false }],
        local: { status: 'healthy', admin: true },
      },
      invalidateStores: ['settings', 'nodes'],
    });
    expect(relaySupervisor.getSnapshot).toHaveBeenCalledWith(true);
    expect(toolNames(['settings:gateway:view'])).toContain('manage_relay_pool');
    expect(toolNames(['admin:system'])).toContain('manage_relay_pool');
    expect(toolNames(['nodes:details'])).not.toContain('manage_relay_pool');
  });

  it('requires admin:system for every relay mutation', async () => {
    const { relayPool, relaySupervisor } = registerRelayServices();
    const service = createService();
    const viewer = { ...BASE_USER, scopes: ['settings:gateway:view'] };

    for (const operation of ['retry_recovery', 'rebalance', 'resume_instance']) {
      await expect(
        service.executeTool(viewer, 'manage_relay_pool', { operation, instanceId: INSTANCE_ID })
      ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope admin:system' });
    }
    expect(relaySupervisor.retryRecovery).not.toHaveBeenCalled();
    expect(relayPool.stageRebalance).not.toHaveBeenCalled();
    expect(relayPool.drainInstance).not.toHaveBeenCalled();
  });

  it('drains, resumes, and force-disconnects instances with the route confirmation', async () => {
    const { relayPool, relaySupervisor } = registerRelayServices();
    const service = createService();
    const admin = { ...BASE_USER, scopes: ['admin:system'] };

    await expect(
      service.executeTool(admin, 'manage_relay_pool', { operation: 'drain_instance', instanceId: INSTANCE_ID })
    ).resolves.toMatchObject({ error: expect.stringContaining('confirm') });
    await expect(
      service.executeTool(admin, 'manage_relay_pool', {
        operation: 'drain_instance',
        instanceId: 'relay-1',
        confirm: true,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('uuid') });
    expect(relayPool.drainInstance).not.toHaveBeenCalled();

    await expect(
      service.executeTool(admin, 'manage_relay_pool', {
        operation: 'drain_instance',
        instanceId: INSTANCE_ID,
        confirm: true,
      })
    ).resolves.toEqual({
      result: { instances: [{ id: INSTANCE_ID, draining: false }] },
      invalidateStores: ['settings', 'nodes'],
    });
    expect(relayPool.drainInstance).toHaveBeenLastCalledWith(INSTANCE_ID, 'user-1', true);

    await service.executeTool(admin, 'manage_relay_pool', { operation: 'resume_instance', instanceId: INSTANCE_ID });
    expect(relayPool.drainInstance).toHaveBeenLastCalledWith(INSTANCE_ID, 'user-1', false);

    await expect(
      service.executeTool(admin, 'manage_relay_pool', {
        operation: 'force_disconnect_instance',
        instanceId: INSTANCE_ID,
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('confirm') });
    await service.executeTool(admin, 'manage_relay_pool', {
      operation: 'force_disconnect_instance',
      instanceId: INSTANCE_ID,
      confirm: true,
    });
    expect(relayPool.forceDisconnectInstance).toHaveBeenCalledWith(INSTANCE_ID, 'user-1');

    await expect(service.executeTool(admin, 'manage_relay_pool', { operation: 'rebalance' })).resolves.toMatchObject({
      result: [{ state: 'staging' }],
    });
    await expect(
      service.executeTool(admin, 'manage_relay_pool', { operation: 'retry_recovery' })
    ).resolves.toMatchObject({ result: { status: 'recovering' } });
    expect(relayPool.stageRebalance).toHaveBeenCalledWith('user-1');
    expect(relaySupervisor.retryRecovery).toHaveBeenCalledWith('user-1');
  });

  it('surfaces relay policy trust and the last health error from the pool snapshot', async () => {
    const { relayPool } = registerRelayServices();
    const policyTrust = { state: 'locked_out', message: 'Re-enroll it', observedAt: 'now', trustedKeyIds: [] };
    relayPool.getSnapshot.mockResolvedValue({
      health: { lastError: 'policy rejected' },
      instances: [{ id: INSTANCE_ID, policyTrust }],
    });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:view'] }, 'manage_relay_pool', {
        operation: 'get',
      })
    ).resolves.toMatchObject({
      result: { health: { lastError: 'policy rejected' }, instances: [{ id: INSTANCE_ID, policyTrust }] },
    });
  });

  it('reads the local relay policy trust with settings:gateway:view', async () => {
    registerRelayServices();
    const service = createService();
    const viewer = { ...BASE_USER, scopes: ['settings:gateway:view'] };

    await expect(
      service.executeTool(viewer, 'manage_relay_pool', { operation: 'local_policy_trust_status' })
    ).resolves.toMatchObject({ result: { localPolicyTrust: null } });

    const status = { state: 'trusted', message: 'ok', observedAt: 'now', trustedKeyIds: ['key-1'] };
    container.registerInstance(RelayPolicyService, {
      getLocalPolicyTrustStatus: vi.fn().mockReturnValue(status),
    } as unknown as RelayPolicyService);
    await expect(
      service.executeTool(viewer, 'manage_relay_pool', { operation: 'local_policy_trust_status' })
    ).resolves.toMatchObject({ result: { localPolicyTrust: status } });
  });

  it('renews relay certificates like POST /system/relay/instances/{id}/renew-certificate', async () => {
    const { relayPool } = registerRelayServices();
    const service = createService();
    const args = { operation: 'renew_certificate', instanceId: INSTANCE_ID };

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:view'] }, 'manage_relay_pool', args)
    ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope admin:system' });
    expect(relayPool.renewInstanceCertificate).not.toHaveBeenCalled();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['admin:system'] }, 'manage_relay_pool', args)
    ).resolves.toMatchObject({ result: { instances: [{ id: INSTANCE_ID }] } });
    expect(relayPool.renewInstanceCertificate).toHaveBeenCalledWith(INSTANCE_ID, 'user-1');
  });

  it('issues a relay re-enrollment like POST /system/relay/instances/{id}/reenroll', async () => {
    const { relayPool } = registerRelayServices();
    const nodesService = {
      getGatewayEnrollmentCertificateFingerprint: vi.fn().mockResolvedValue('sha256:gateway'),
      getGatewayEnrollmentTargets: vi.fn().mockResolvedValue(['gateway.example.com:7443']),
    };
    const service = createService({ nodesService });
    const args = { operation: 'reenroll_instance', instanceId: INSTANCE_ID, confirm: true };

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:view'] }, 'manage_relay_pool', args)
    ).resolves.toMatchObject({ error: 'PERMISSION_DENIED: Missing required scope admin:system' });
    const admin = { ...BASE_USER, scopes: ['admin:system'] };
    await expect(
      service.executeTool(admin, 'manage_relay_pool', { operation: 'reenroll_instance', instanceId: INSTANCE_ID })
    ).resolves.toMatchObject({ error: expect.stringContaining('confirm') });
    expect(relayPool.issueRelayReenrollment).not.toHaveBeenCalled();

    await expect(service.executeTool(admin, 'manage_relay_pool', args)).resolves.toEqual({
      result: {
        enrollmentToken: 'gw_enroll_relay',
        installCommand: 'curl ... | sh',
        gatewayCertSha256: 'sha256:gateway',
        gatewayEnrollmentTargets: ['gateway.example.com:7443'],
      },
      invalidateStores: ['settings', 'nodes'],
    });
    expect(relayPool.issueRelayReenrollment).toHaveBeenCalledWith(INSTANCE_ID, 'user-1');
    expect(isImpersonationBlockedToolCall('manage_relay_pool', args)).toBe(true);
    expect(isImpersonationBlockedToolCall('manage_relay_pool', { operation: 'get' })).toBe(false);
  });

  it('rejects unknown relay operations in the argument schema', () => {
    expect(parseAndValidateAIToolArguments('manage_relay_pool', JSON.stringify({ operation: 'delete' }))).toMatchObject(
      {
        ok: false,
      }
    );
    expect(
      parseAndValidateAIToolArguments('manage_relay_pool', JSON.stringify({ operation: 'get', extra: true }))
    ).toMatchObject({ ok: false });
  });
});

describe('get_audit_log', () => {
  it('passes the audit route filters and caps the page size', async () => {
    const auditService = {
      log: vi.fn(),
      getAuditLog: vi.fn().mockResolvedValue({ data: [], total: 0 }),
      getAuditUsers: vi.fn().mockResolvedValue([{ userId: 'user-2', userName: 'Ops', userEmail: null }]),
    };
    const service = createService({ auditService });
    const auditor = { ...BASE_USER, scopes: ['admin:audit'] };

    await service.executeTool(auditor, 'get_audit_log', {
      action: 'user.create',
      actions: ['user.delete'],
      resourceTypes: ['user'],
      userIds: ['user-2'],
      excludedActions: ['mcp.list_nodes'],
      from: '2026-09-01T00:00:00Z',
      to: 'not-a-date',
      limit: 500,
    });
    expect(auditService.getAuditLog).toHaveBeenCalledWith({
      actions: ['user.delete', 'user.create'],
      resourceTypes: ['user'],
      userIds: ['user-2'],
      excludedActions: ['mcp.list_nodes'],
      excludedResourceTypes: [],
      from: new Date('2026-09-01T00:00:00Z'),
      to: undefined,
      page: 1,
      limit: 100,
    });

    await expect(service.executeTool(auditor, 'get_audit_log', { view: 'users' })).resolves.toEqual({
      result: [{ userId: 'user-2', userName: 'Ops', userEmail: null }],
      invalidateStores: [],
    });
  });

  it('exports only with the audit-export license feature', async () => {
    const requireFeature = vi.fn().mockRejectedValueOnce(new Error('Audit export requires Business'));
    container.registerInstance(LicensePolicyService, { requireFeature } as unknown as LicensePolicyService);
    const auditService = { log: vi.fn(), getAuditExport: vi.fn().mockResolvedValue([{ id: 'entry-1' }]) };
    const service = createService({ auditService });
    const auditor = { ...BASE_USER, scopes: ['admin:audit'] };

    await expect(service.executeTool(auditor, 'get_audit_log', { view: 'export' })).resolves.toMatchObject({
      error: 'Audit export requires Business',
    });
    expect(auditService.getAuditExport).not.toHaveBeenCalled();

    await expect(
      service.executeTool(auditor, 'get_audit_log', { view: 'export', actions: ['user.create'] })
    ).resolves.toEqual({ result: [{ id: 'entry-1' }], invalidateStores: [] });
    expect(requireFeature).toHaveBeenLastCalledWith('audit-export');
    expect(auditService.getAuditExport).toHaveBeenCalledWith(
      expect.objectContaining({ actions: ['user.create'], from: undefined, to: undefined })
    );
    expect(toolNames(['proxy:view'])).not.toContain('get_audit_log');
  });
});

describe('get_dashboard_stats', () => {
  it('includes system certificates only for admin:details:certificates', async () => {
    const monitoringService = {
      getDashboardStats: vi.fn().mockResolvedValue({ nodes: { total: 1 } }),
    };
    const service = createService({ monitoringService });

    await service.executeTool({ ...BASE_USER, scopes: ['ai:workspace:use', 'nodes:details'] }, 'get_dashboard_stats', {
      showSystem: true,
    });
    expect(monitoringService.getDashboardStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ showSystem: false })
    );

    await service.executeTool(
      { ...BASE_USER, scopes: ['ai:workspace:use', 'nodes:details', 'admin:details:certificates'] },
      'get_dashboard_stats',
      { showSystem: true }
    );
    expect(monitoringService.getDashboardStats).toHaveBeenLastCalledWith(expect.objectContaining({ showSystem: true }));
  });
});

describe('manage_logging_backend', () => {
  it('validates backend changes with the Gateway settings schema before anything is saved', async () => {
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:view'] }, 'manage_logging_backend', {
        operation: 'enable_local',
      })
    ).resolves.toMatchObject({ error: 'Missing required scope: settings:gateway:edit' });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['settings:gateway:edit'] }, 'manage_logging_backend', {
        operation: 'configure_external',
        url: 'not a url',
        username: 'gateway',
        password: 'secret',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('url') });
  });
});
