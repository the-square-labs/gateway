import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import {
  createDockerRegistryMaintenanceExecutor,
  DockerInternalRegistryService,
  type DockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceStore,
  type RegistryRetentionArtifact,
  selectRegistryRetentionCandidates,
} from './docker-registry-internal.service.js';
import { REGISTRY_WRITE_DRAIN_GRACE_MS } from './docker-registry-maintenance.js';

function artifact(id: string, ageMinutes: number, pinned = false, retainInHistory = true): RegistryRetentionArtifact {
  return {
    id,
    sourceBindingId: 'source-1',
    repository: 'gateway/source-1',
    digest: `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
    createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0) - ageMinutes * 60_000),
    pinned,
    retainInHistory,
  };
}

class FakeStore implements DockerRegistryMaintenanceStore {
  readonly events: string[] = [];
  readonly deleted = new Set<string>();
  state: any = {
    id: 'system',
    status: 'ready',
    writable: true,
    storageBackend: 'filesystem',
    storageUsedBytes: 0,
    storageCapacityBytes: null,
    externalAccessEnabled: false,
    externalHostname: null,
    externalNginxNodeId: null,
    externalCertificateId: null,
    maintenancePhase: 'idle',
    maintenanceLeaseOwner: null,
    maintenanceLeaseExpiresAt: null,
    lastGcAt: null,
    nextGcAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  run: any;

  constructor(readonly artifacts = [artifact('a', 0), artifact('b', 1), artifact('c', 2), artifact('d', 3)]) {}

  async initialize() {}
  async getState() {
    return this.state;
  }
  async updateState(values: Record<string, unknown>) {
    this.state = { ...this.state, ...values };
    if (values.maintenancePhase) this.events.push(`state:${values.maintenancePhase}`);
    return this.state;
  }
  async acquireLease(owner: string, leaseExpiresAt: Date) {
    this.state = {
      ...this.state,
      status: 'maintenance',
      writable: false,
      maintenancePhase: 'acquiring_lease',
      maintenanceLeaseOwner: owner,
      maintenanceLeaseExpiresAt: leaseExpiresAt,
    };
    this.events.push('state:acquiring_lease');
    return this.state;
  }
  async renewLease(owner: string, leaseExpiresAt: Date) {
    if (this.state.maintenanceLeaseOwner !== owner) throw new Error('lease lost');
    this.state.maintenanceLeaseExpiresAt = leaseExpiresAt;
  }
  async createRun(owner: string, leaseExpiresAt: Date, dryRun: boolean) {
    this.run = {
      id: 'run-1',
      phase: 'acquiring_lease',
      status: 'running',
      dryRun,
      leaseOwner: owner,
      leaseExpiresAt,
      progress: {},
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
    return this.run;
  }
  async getRun(id: string) {
    if (this.run?.id !== id) throw new Error('not found');
    return this.run;
  }
  async updateRun(_id: string, values: Record<string, unknown>) {
    this.run = { ...this.run, ...values };
    if (values.phase) this.events.push(`run:${values.phase}`);
    return this.run;
  }
  async listRetentionArtifacts() {
    return this.artifacts.filter((item) => !this.deleted.has(item.id));
  }
  async markArtifactDeleted(id: string) {
    this.deleted.add(id);
  }
  async markInterruptedRunsFailed(_now: Date, message: string) {
    if (this.run?.status === 'running') this.run = { ...this.run, status: 'failed', phase: 'failed', error: message };
  }
}

function createExecutor(store: FakeStore, failAction?: string) {
  let pendingFailure = failAction;
  const invoke = async (name: string) => {
    store.events.push(`exec:${name}`);
    if (pendingFailure === name) {
      pendingFailure = undefined;
      throw new Error(`failed:${name}`);
    }
  };
  const executor: DockerRegistryMaintenanceExecutor = {
    hasRepositories: async () => true,
    pauseAdmissions: () => invoke('pauseAdmissions'),
    drainUploads: () => invoke('drainUploads'),
    deleteManifest: () => invoke('deleteManifest'),
    enterReadOnly: () => invoke('enterReadOnly'),
    collectGarbage: () => invoke('collectGarbage'),
    verifyIntegrity: () => invoke('verifyIntegrity'),
    restoreWrites: () => invoke('restoreWrites'),
  };
  return executor;
}

function createService(
  store: FakeStore,
  executor: DockerRegistryMaintenanceExecutor,
  tokenService: { issueToken: ReturnType<typeof vi.fn> } = { issueToken: vi.fn().mockReturnValue({ token: 'token' }) },
  requireFeature = vi.fn().mockResolvedValue(undefined),
  requireFeatureForExistingRuntime = requireFeature
) {
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new DockerInternalRegistryService({} as never, tokenService as never, audit as never, store);
  service.setExecutor(executor);
  service.setLicensePolicyService({ requireFeature, requireFeatureForExistingRuntime } as never);
  return { service, audit, requireFeature, requireFeatureForExistingRuntime };
}

describe('DockerInternalRegistryService', () => {
  it('finishes empty registry maintenance without the write-drain delay or offline GC', async () => {
    const store = new FakeStore([]);
    const executor = createExecutor(store);
    executor.hasRepositories = vi.fn().mockResolvedValue(false);
    const { service } = createService(store, executor);

    await expect(
      service.runGarbageCollection({ requestedById: 'user-1', leaseOwner: 'owner-1' })
    ).resolves.toMatchObject({
      status: 'completed',
      phase: 'idle',
      progress: expect.objectContaining({
        retainedArtifactIds: [],
        candidateArtifactIds: [],
        skippedEmptyRegistry: true,
      }),
    });
    expect(store.events.filter((event) => event.startsWith('exec:'))).toEqual([]);
    expect(store.state).toMatchObject({ status: 'ready', writable: true, maintenancePhase: 'idle' });
  });

  it('retains only the latest approved artifact per source plus every active pin', () => {
    const artifacts = [artifact('a', 0), artifact('b', 1), artifact('c', 2), artifact('d', 3), artifact('e', 4, true)];
    const result = selectRegistryRetentionCandidates(artifacts);
    expect(result.retained.map((item) => item.id)).toEqual(['a', 'e']);
    expect(result.candidates.map((item) => item.id)).toEqual(['b', 'c', 'd']);
  });

  it('does not delete a shared registry digest while a newer build still retains it', () => {
    const sharedDigest = `sha256:${'a'.repeat(64)}`;
    const artifacts = [artifact('new', 0), artifact('b', 1), artifact('c', 2), artifact('old', 3)];
    artifacts[0]!.digest = sharedDigest;
    artifacts[3]!.digest = sharedDigest;
    const result = selectRegistryRetentionCandidates(artifacts);
    expect(result.retained.map((item) => item.id)).toContain('old');
    expect(result.candidates.map((item) => item.id)).not.toContain('old');
  });

  it('collects an unpinned artifact from a failed rollout instead of retaining it as build history', () => {
    const failedRollout = artifact('failed', 0, false, false);
    const result = selectRegistryRetentionCandidates([
      failedRollout,
      artifact('a', 1),
      artifact('b', 2),
      artifact('c', 3),
    ]);
    expect(result.retained.map((item) => item.id)).toEqual(['a']);
    expect(result.candidates.map((item) => item.id)).toEqual(['failed', 'b', 'c']);
  });

  it('fails closed for writes at disk pressure while preserving scoped pull token issuance', async () => {
    const store = new FakeStore();
    const tokenService = { issueToken: vi.fn().mockReturnValue({ token: 'pull-token' }) };
    const { service } = createService(store, createExecutor(store), tokenService);
    await service.reportHealth({ healthy: true, writable: true, usedBytes: 95, capacityBytes: 100 });
    expect(store.state).toMatchObject({ status: 'degraded', writable: false });
    await expect(service.assertBuildAdmission()).rejects.toMatchObject({ code: 'INTERNAL_REGISTRY_NOT_WRITABLE' });
    await expect(
      service.issueToken({
        subject: 'builder:node-1:build-1',
        requested: [{ repository: 'gateway/source-1', actions: ['push'] }],
        allowed: [{ repository: 'gateway/source-1', actions: ['push'] }],
        context: { nodeId: 'node-1', buildId: 'build-1' },
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_REGISTRY_NOT_WRITABLE' });
    await expect(
      service.issueToken({
        subject: 'runtime:node-2:deployment-1',
        requested: [{ repository: 'gateway/source-1', actions: ['pull'] }],
        allowed: [{ repository: 'gateway/source-1', actions: ['pull'] }],
        context: { nodeId: 'node-2', deploymentId: 'deployment-1' },
      })
    ).resolves.toEqual({ token: 'pull-token' });
    expect(tokenService.issueToken).toHaveBeenCalledOnce();
  });

  it('publishes internal registry state changes on the shared Docker registry channel', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));
    const publish = vi.fn();
    service.setEventBus({ publish } as never);

    await service.reportHealth({ healthy: true, writable: true, usedBytes: 10, capacityBytes: 100 });

    expect(publish).toHaveBeenCalledWith(
      'docker.registry.changed',
      expect.objectContaining({
        id: 'gateway-internal-registry',
        action: 'health',
        status: 'ready',
        writable: true,
      })
    );
  });

  it('does not persist or publish an unchanged internal registry health report', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));
    const publish = vi.fn();
    const updateState = vi.spyOn(store, 'updateState');
    service.setEventBus({ publish } as never);

    await service.reportHealth({ healthy: true, writable: true, usedBytes: 0, capacityBytes: null });

    expect(updateState).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('limits every write grant to the bounded maintenance drain window', async () => {
    const store = new FakeStore();
    const tokenService = { issueToken: vi.fn().mockReturnValue({ token: 'write-token' }) };
    const { service } = createService(store, createExecutor(store), tokenService);
    await service.issueToken({
      subject: 'builder:node-1:build-1',
      requested: [{ repository: 'gateway/source-1', actions: ['push'] }],
      allowed: [{ repository: 'gateway/source-1', actions: ['push'] }],
      ttlSeconds: 300,
    });
    expect(tokenService.issueToken).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 30 }));
  });

  it('expires write grants and severs remaining sessions before destructive maintenance', async () => {
    const calls: string[] = [];
    const docker = {
      restartManagedRegistry: vi.fn(async () => calls.push('restart')),
      stopManagedRegistry: vi.fn(async () => calls.push('stop')),
      runManagedRegistryGarbageCollection: vi.fn(async () => calls.push('gc')),
      recoverManagedRegistryMaintenance: vi.fn(async () => calls.push('recover')),
    };
    const wait = vi.fn(async (milliseconds: number) => {
      calls.push(`wait:${milliseconds}`);
    });
    const executor = createDockerRegistryMaintenanceExecutor(
      docker as never,
      { issueToken: vi.fn().mockReturnValue({ token: 'maintenance-token' }) } as never,
      'http://registry:5000',
      wait
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await executor.drainUploads();
    expect(calls).toEqual(['wait:35000', 'restart']);
    await executor.enterReadOnly();
    await executor.restoreWrites();
    expect(calls).toEqual(['wait:35000', 'restart', 'stop', 'recover']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('waits for the managed registry to become ready after a restart', async () => {
    const waits: number[] = [];
    const docker = {
      restartManagedRegistry: vi.fn(),
      stopManagedRegistry: vi.fn(),
      runManagedRegistryGarbageCollection: vi.fn(),
      recoverManagedRegistryMaintenance: vi.fn(),
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const executor = createDockerRegistryMaintenanceExecutor(
      docker as never,
      { issueToken: vi.fn() } as never,
      'http://registry:5000',
      async (milliseconds) => {
        waits.push(milliseconds);
      }
    );

    await executor.drainUploads();

    expect(docker.restartManagedRegistry).toHaveBeenCalledOnce();
    expect(waits).toEqual([REGISTRY_WRITE_DRAIN_GRACE_MS, 250]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('automatically restores an interrupted offline maintenance run on startup', async () => {
    const store = new FakeStore();
    store.state = { ...store.state, status: 'maintenance', writable: false, maintenancePhase: 'collecting_blobs' };
    store.run = { id: 'run-1', status: 'running', phase: 'collecting_blobs' };
    const executor = createExecutor(store);
    const { service } = createService(store, executor);
    await service.recoverInterruptedMaintenance();
    expect(store.events).toContain('exec:restoreWrites');
    expect(store.state).toMatchObject({ status: 'ready', writable: true, maintenancePhase: 'idle' });
    expect(store.run).toMatchObject({ status: 'failed', phase: 'failed' });
  });

  it('applies external ingress before publishing enabled state and publishes disabled state before teardown', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));
    const observations: Array<{ enabled: boolean; stored: boolean }> = [];
    service.setExternalAccessReconciler(async (next) => {
      observations.push({ enabled: next.externalAccessEnabled, stored: store.state.externalAccessEnabled });
    });

    await service.updateSettings(
      {
        externalAccessEnabled: true,
        externalHostname: 'registry.example.com',
        externalNginxNodeId: '11111111-1111-4111-8111-111111111111',
        externalCertificateId: '22222222-2222-4222-8222-222222222222',
      },
      'user-1'
    );
    await service.updateSettings({ externalAccessEnabled: false }, 'user-1');

    expect(observations).toEqual([
      { enabled: true, stored: false },
      { enabled: false, stored: false },
    ]);
    expect(store.state.externalAccessEnabled).toBe(false);
  });

  it('requires Business only when external access is enabled', async () => {
    const store = new FakeStore();
    const requireFeature = vi
      .fn()
      .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required'));
    const { service } = createService(store, createExecutor(store), undefined, requireFeature);
    service.setExternalAccessReconciler(vi.fn());

    await expect(
      service.updateSettings(
        {
          externalAccessEnabled: true,
          externalHostname: 'registry.example.com',
          externalNginxNodeId: '11111111-1111-4111-8111-111111111111',
          externalCertificateId: '22222222-2222-4222-8222-222222222222',
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    await expect(service.updateSettings({ externalAccessEnabled: false }, 'user-1')).resolves.toMatchObject({
      externalAccessEnabled: false,
    });
    expect(requireFeature).toHaveBeenCalledTimes(1);
    expect(requireFeature).toHaveBeenCalledWith('git-push-to-deploy');
  });

  it('blocks external token issuance when Business is unavailable without affecting internal pulls', async () => {
    const store = new FakeStore();
    store.state = { ...store.state, externalAccessEnabled: true };
    const tokenService = { issueToken: vi.fn().mockReturnValue({ token: 'token' }) };
    const requireFeature = vi
      .fn()
      .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required'));
    const { service } = createService(store, createExecutor(store), tokenService, requireFeature);

    await expect(
      service.issueToken({
        subject: 'external-client',
        requested: [{ repository: 'tenant/app', actions: ['pull'] }],
        allowed: [{ repository: 'tenant/app', actions: ['pull'] }],
        externalAccess: true,
      })
    ).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    await expect(
      service.issueToken({
        subject: 'runtime:node-1',
        requested: [{ repository: 'tenant/app', actions: ['pull'] }],
        allowed: [{ repository: 'tenant/app', actions: ['pull'] }],
      })
    ).resolves.toEqual({ token: 'token' });
    expect(tokenService.issueToken).toHaveBeenCalledOnce();
  });

  it('persists disabled external access before entitlement-loss ingress teardown', async () => {
    const store = new FakeStore();
    store.state = {
      ...store.state,
      externalAccessEnabled: true,
      externalHostname: 'registry.example.com',
      externalNginxNodeId: '11111111-1111-4111-8111-111111111111',
      externalCertificateId: '22222222-2222-4222-8222-222222222222',
    };
    const { service, audit } = createService(store, createExecutor(store));
    const observations: Array<{ enabled: boolean; stored: boolean }> = [];
    service.setExternalAccessReconciler(async (next) => {
      observations.push({ enabled: next.externalAccessEnabled, stored: store.state.externalAccessEnabled });
    });

    await expect(service.disableExternalAccessForEntitlementLoss()).resolves.toBe(true);

    expect(observations).toEqual([{ enabled: false, stored: false }]);
    expect(store.state).toMatchObject({
      externalAccessEnabled: false,
      externalHostname: null,
      externalNginxNodeId: null,
      externalCertificateId: null,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.internal-registry.external-access.disabled-by-license' })
    );
  });

  it('refuses to publish external access when ingress reconciliation is unavailable', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));
    await expect(
      service.updateSettings(
        {
          externalAccessEnabled: true,
          externalHostname: 'registry.example.com',
          externalNginxNodeId: '11111111-1111-4111-8111-111111111111',
          externalCertificateId: '22222222-2222-4222-8222-222222222222',
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'REGISTRY_INGRESS_UNAVAILABLE' });
    expect(store.state.externalAccessEnabled).toBe(false);
  });

  it('persists every maintenance phase before invoking its external side effect', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));
    await expect(
      service.runGarbageCollection({ requestedById: 'user-1', leaseOwner: 'owner-1' })
    ).resolves.toMatchObject({
      status: 'completed',
      phase: 'idle',
    });

    for (const [phase, action] of [
      ['pausing_admission', 'pauseAdmissions'],
      ['draining_uploads', 'drainUploads'],
      ['deleting_manifests', 'deleteManifest'],
      ['entering_read_only', 'enterReadOnly'],
      ['collecting_blobs', 'collectGarbage'],
      ['verifying', 'verifyIntegrity'],
      ['restoring_writes', 'restoreWrites'],
    ]) {
      expect(store.events.indexOf(`state:${phase}`)).toBeLessThan(store.events.indexOf(`exec:${action}`));
    }
    expect(store.deleted).toEqual(new Set(['b', 'c', 'd']));
    expect(store.state).toMatchObject({ status: 'ready', writable: true, maintenancePhase: 'idle' });
  });

  it('uses and persists a configurable successful-artifact retention count', async () => {
    const store = new FakeStore();
    const { service } = createService(store, createExecutor(store));

    await expect(
      service.runGarbageCollection({ requestedById: 'user-1', leaseOwner: 'owner-1', retentionCount: 1 })
    ).resolves.toMatchObject({
      progress: expect.objectContaining({
        retentionCount: 1,
        retainedArtifactIds: ['a'],
        candidateArtifactIds: ['b', 'c', 'd'],
      }),
    });
    expect(store.deleted).toEqual(new Set(['b', 'c', 'd']));
  });

  for (const action of [
    'pauseAdmissions',
    'drainUploads',
    'deleteManifest',
    'enterReadOnly',
    'collectGarbage',
    'verifyIntegrity',
  ]) {
    it(`records a ${action} failure and restores registry writes`, async () => {
      const store = new FakeStore();
      const { service } = createService(store, createExecutor(store, action));
      await expect(service.runGarbageCollection({ requestedById: 'user-1', leaseOwner: 'owner-1' })).rejects.toThrow(
        `failed:${action}`
      );
      expect(store.run).toMatchObject({
        status: 'failed',
        phase: 'failed',
        progress: expect.objectContaining({ restoredAfterFailure: true }),
      });
      expect(store.state).toMatchObject({ status: 'degraded', writable: true, maintenancePhase: 'failed' });
      expect(store.events.at(-1)).toBe('state:failed');
      expect(store.events).toContain('exec:restoreWrites');
    });
  }

  it('resumes a persisted failed run idempotently after the failed control action recovers', async () => {
    const store = new FakeStore();
    const executor = createExecutor(store, 'collectGarbage');
    const { service } = createService(store, executor);
    await expect(service.runGarbageCollection({ requestedById: 'user-1', leaseOwner: 'owner-1' })).rejects.toThrow(
      'failed:collectGarbage'
    );

    await expect(service.resumeMaintenance('run-1', 'owner-2')).resolves.toMatchObject({
      status: 'completed',
      phase: 'idle',
    });
    expect(store.state).toMatchObject({ status: 'ready', writable: true, maintenancePhase: 'idle' });
  });
});
