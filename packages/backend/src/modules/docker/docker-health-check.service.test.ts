import { describe, expect, it, vi } from 'vitest';
import { auditLog, dockerAccessResources, dockerHealthChecks } from '@/db/schema/index.js';
import { DockerHealthCheckService } from './docker-health-check.service.js';

function availabilityDb(rows: Array<{ nodeId: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  return { db: { select: vi.fn(() => ({ from })) }, limit };
}

describe('DockerHealthCheckService Availability routing', () => {
  it('resolves the serving runtime before inspecting container route options', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Config: { Labels: {} }, HostConfig: { PortBindings: {} } }),
      }),
    };
    const service = new DockerHealthCheckService({} as never, dispatch as never) as any;
    service.setWorkloadResolver({
      resolveContainerRuntimeTarget: vi.fn().mockResolvedValue({
        nodeId: 'serving-node',
        containerId: 'serving-container',
      }),
    });

    await expect(service.getContainerRouteOptions('origin-node', 'availability-container')).resolves.toEqual([]);
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('serving-node', 'inspect', {
      containerId: 'serving-container',
    });
  });

  it('probes the current serving placement instead of the unavailable deployment origin', async () => {
    const { db } = availabilityDb([{ nodeId: 'serving-node' }]);
    const service = new DockerHealthCheckService(db as never, {} as never) as any;

    await expect(
      service.resolveAvailabilityProbeNodeId({
        target: 'deployment',
        nodeId: 'origin-node',
        deploymentId: 'deployment-1',
        containerName: null,
      })
    ).resolves.toBe('serving-node');
  });

  it('keeps the original node when Availability has no serving placement', async () => {
    const { db } = availabilityDb([]);
    const service = new DockerHealthCheckService(db as never, {} as never) as any;

    await expect(
      service.resolveAvailabilityProbeNodeId({
        target: 'container',
        nodeId: 'origin-node',
        deploymentId: null,
        containerName: 'api',
      })
    ).resolves.toBe('origin-node');
  });
});

describe('intentionally stopped HA health', () => {
  function fixture(resourceKind = 'container') {
    const row = {
      id: 'check',
      target: resourceKind === 'deployment' ? 'deployment' : 'container',
      nodeId: 'node',
      containerName: resourceKind === 'deployment' ? null : 'app',
      deploymentId: resourceKind === 'deployment' ? 'deployment' : null,
      enabled: true,
      healthStatus: 'offline',
      healthHistory: [{ ts: '2026-09-03T00:00:00Z', status: 'online' }],
    };
    const policy = { id: 'policy', mode: 'replicated', resourceKind, shouldRun: false, desiredReplicaCount: 2 };
    const set = vi.fn((_patch: unknown) => ({ where: vi.fn() }));
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({ where: vi.fn().mockResolvedValue(table === dockerHealthChecks ? [row] : []) }),
      })),
      update: vi.fn(() => ({ set })),
      query: { dockerHealthChecks: { findFirst: vi.fn().mockResolvedValue(row) } },
    };
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const service = new DockerHealthCheckService(db as never, dispatch as never) as any;
    service.setWorkloadResolver({
      findPolicy: vi.fn().mockImplementation(async () => policy),
      resolveContainerRuntimeTarget: vi.fn(),
    });
    service.databaseDependencyState = vi
      .fn()
      .mockResolvedValue({ offline: true, hasBindings: true, cause: 'binding_error' });
    service.getDeploymentName = vi.fn().mockResolvedValue('app');
    const evaluator = { observeStatefulEvent: vi.fn() };
    service.setEvaluator(evaluator);
    const events = { subscribe: vi.fn(), publish: vi.fn() };
    service.setEventBus(events);
    return { service, policy, row, db, set, dispatch, evaluator, events };
  }

  it.each([
    'container',
    'deployment',
    'compose',
  ])('skips scheduled %s probes and dependency alerts while stopped', async (kind) => {
    const { service, set, dispatch, evaluator, events } = fixture(kind);
    await service.runDueChecks();
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
    expect(service.databaseDependencyState).not.toHaveBeenCalled();
    expect(evaluator.observeStatefulEvent).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ healthStatus: 'disabled', lastHealthCheckAt: expect.any(Date) })
    );
    expect(set.mock.calls[0][0]).not.toHaveProperty('healthHistory');
    expect(set.mock.calls[0][0]).not.toHaveProperty('enabled');
    expect(events.publish).toHaveBeenCalledWith(
      'docker.health.changed',
      expect.objectContaining({
        action: 'health.stopped',
        healthStatus: 'stopped',
        health_cause: null,
      })
    );
  });

  it.each(['container', 'deployment'])('skips manual %s health tests without route/config errors', async (kind) => {
    const { service, dispatch } = fixture(kind);
    const result =
      kind === 'container'
        ? await service.testContainer('node', 'app')
        : await service.testDeployment('node', 'deployment');
    expect(result).toEqual({ ok: true, status: 'stopped', skipped: true });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('does not publish an in-flight failure after Stop has been requested', async () => {
    const { service, policy, row, set, evaluator } = fixture();
    policy.shouldRun = true;
    service.probeRow = vi.fn(async () => {
      policy.shouldRun = false;
      return { status: 'offline', ok: false };
    });
    await service.checkAndStore(row);
    expect(evaluator.observeStatefulEvent).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ healthStatus: 'disabled' }));
    expect(set.mock.calls[0][0]).not.toHaveProperty('healthHistory');
  });

  it('discards a just-written failure if Stop arrives before notification evaluation', async () => {
    const { service, policy, row, set, evaluator } = fixture('deployment');
    policy.shouldRun = true;
    service.probeRow = vi.fn().mockResolvedValue({ status: 'offline', ok: false });
    service.getDeploymentName = vi.fn(async () => {
      policy.shouldRun = false;
      return 'app';
    });
    await service.checkAndStore(row);
    expect(evaluator.observeStatefulEvent).not.toHaveBeenCalled();
    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthStatus: 'disabled', healthHistory: row.healthHistory })
    );
  });

  it('resumes normal health evaluation after Start without changing enabled configuration', async () => {
    const { service, policy, row, set, evaluator } = fixture();
    await service.checkAndStore(row);
    policy.shouldRun = true;
    row.healthStatus = 'disabled';
    service.databaseDependencyState.mockResolvedValue({ offline: false, hasBindings: false, cause: null });
    await service.checkAndStore(row);
    expect(service.databaseDependencyState).toHaveBeenCalledOnce();
    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ healthStatus: 'offline', healthHistory: expect.any(Array) })
    );
    expect(evaluator.observeStatefulEvent).toHaveBeenCalledWith(
      'container',
      'health.offline',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(row.enabled).toBe(true);
  });

  it('projects stopped container detail without inspecting its runtime', async () => {
    const { service, dispatch } = fixture();
    const result = await service.getContainer('node', 'app');
    expect(result.healthStatus).toBe('stopped');
    expect(result.enabled).toBe(true);
    expect(result.routeOptions).toEqual([]);
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('projects stopped health rows immediately, before the next scheduled tick', async () => {
    const { service } = fixture();
    const rows = await service.getRowsForContainers('node', ['app']);
    expect(rows.get('app')).toMatchObject({ healthStatus: 'stopped', enabled: true });
  });

  it('does not publish repeated stopped events on every tick', async () => {
    const { service, row, events } = fixture();
    row.healthStatus = 'disabled';
    await service.checkAndStore(row);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('checks shouldRun before placement counts even without the runtime resolver', async () => {
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'policy', shouldRun: false }] }) }),
    }));
    const service = new DockerHealthCheckService({ select } as never, {} as never) as any;
    expect(
      await service.availabilityHealth({ target: 'deployment', nodeId: 'node', deploymentId: 'deployment' })
    ).toEqual({ ok: true, status: 'stopped' });
    expect(select).toHaveBeenCalledOnce();
  });

  it.each([
    'stopped',
    'ready',
    'failed',
  ])('only suppresses explicitly stopped single deployments (%s)', async (status) => {
    const limit = vi.fn().mockResolvedValue([{ status }]);
    const service = new DockerHealthCheckService(
      { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as never,
      {} as never
    ) as any;
    service.findAvailabilityPolicy = vi.fn().mockResolvedValue(null);
    expect(
      await service.isIntentionallyStopped({ target: 'deployment', deploymentId: 'deployment', nodeId: 'node' })
    ).toBe(status === 'stopped');
  });

  it.each([
    'stop',
    'start',
    'restart',
    'kill',
    undefined,
  ])('uses explicit single-container lifecycle intent, not offline state (%s)', async (action) => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === dockerAccessResources
                ? [{ runtimeId: 'runtime' }]
                : table === auditLog && action
                  ? [{ action: `docker.container.${action}` }]
                  : [];
            const limit = vi.fn().mockResolvedValue(rows);
            return { limit, orderBy: () => ({ limit }) };
          },
        }),
      }),
    };
    const service = new DockerHealthCheckService(db as never, {} as never) as any;
    service.findAvailabilityPolicy = vi.fn().mockResolvedValue(null);
    expect(await service.isIntentionallyStopped({ target: 'container', containerName: 'app', nodeId: 'node' })).toBe(
      action === 'stop'
    );
  });

  it('uses current Compose desired state after disabling HA, not the stale single policy shouldRun', async () => {
    let desiredState = 'stopped';
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ desiredState }] }) }) }) };
    const service = new DockerHealthCheckService(db as never, {} as never) as any;
    service.findAvailabilityPolicy = vi
      .fn()
      .mockResolvedValue({ mode: 'single', shouldRun: false, composeProjectId: 'project' });
    const target = { target: 'container', containerName: 'app-web', nodeId: 'node' };
    expect(await service.isIntentionallyStopped(target)).toBe(true);
    desiredState = 'running';
    expect(await service.isIntentionallyStopped(target)).toBe(false);
  });
});
