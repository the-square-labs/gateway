import { randomUUID } from 'node:crypto';
import type { DrizzleClient } from '@/db/client.js';
import type { DockerRegistryMaintenancePhase } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerInternalRegistrySettingsInput } from './docker-build.schemas.js';
import {
  createDockerRegistryMaintenanceStore,
  DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS,
  type DockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceStore,
  MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS,
  type MaintenanceRun,
  type RegistryState,
  selectRegistryRetentionCandidates,
  unavailableDockerRegistryMaintenanceExecutor,
} from './docker-registry-maintenance.js';
import type { DockerRegistryGrant, DockerRegistryTokenService } from './docker-registry-token.service.js';

export {
  createDockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceStore,
  type RegistryRetentionArtifact,
  selectRegistryRetentionCandidates,
} from './docker-registry-maintenance.js';

export const INTERNAL_DOCKER_REGISTRY_ID = 'gateway-internal-registry';
const DEFAULT_DISK_PRESSURE_RATIO = 0.9;

export interface DockerRegistryExternalAccessConfig {
  externalAccessEnabled: boolean;
  externalHostname: string | null;
  externalNginxNodeId: string | null;
  externalCertificateId: string | null;
}

export type DockerRegistryExternalAccessReconciler = (
  next: DockerRegistryExternalAccessConfig,
  previous: DockerRegistryExternalAccessConfig,
  userId: string | null
) => Promise<void>;

export class DockerInternalRegistryService {
  private executor: DockerRegistryMaintenanceExecutor = unavailableDockerRegistryMaintenanceExecutor;
  private externalAccessReconciler?: DockerRegistryExternalAccessReconciler;
  private eventBus?: EventBusService;
  private licensePolicyService?: LicensePolicyService;
  private readonly store: DockerRegistryMaintenanceStore;

  constructor(
    db: DrizzleClient,
    private readonly tokenService: DockerRegistryTokenService,
    private readonly auditService: AuditService,
    store?: DockerRegistryMaintenanceStore
  ) {
    this.store = store ?? createDockerRegistryMaintenanceStore(db);
  }

  setExecutor(executor: DockerRegistryMaintenanceExecutor): void {
    this.executor = executor;
  }

  setExternalAccessReconciler(reconciler: DockerRegistryExternalAccessReconciler): void {
    this.externalAccessReconciler = reconciler;
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicyService = service;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async recoverInterruptedMaintenance(): Promise<void> {
    const state = await this.getState();
    if (state.maintenancePhase === 'idle' && state.status !== 'maintenance') return;
    const now = new Date();
    try {
      await this.executor.restoreWrites();
      await this.store.markInterruptedRunsFailed?.(
        now,
        `Gateway restarted during registry maintenance phase ${state.maintenancePhase}`
      );
      await this.store.updateState({
        status: 'ready',
        writable: true,
        maintenancePhase: 'idle',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: null,
      });
    } catch (error) {
      await this.store.updateState({
        status: 'unhealthy',
        writable: false,
        maintenancePhase: 'failed',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: `Automatic registry maintenance recovery failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }

  async getState(): Promise<RegistryState> {
    await this.store.initialize();
    return this.store.getState();
  }

  async probeHealth(registryUrl = process.env.GATEWAY_INTERNAL_REGISTRY_URL || 'http://registry:5000') {
    let healthy = false;
    try {
      const response = await fetch(new URL('/v2/', registryUrl), {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok || response.status === 401;
    } catch {
      healthy = false;
    }
    return this.reportHealth({ healthy, writable: healthy, usedBytes: 0, capacityBytes: null });
  }

  async reportHealth(input: { healthy: boolean; writable: boolean; usedBytes: number; capacityBytes?: number | null }) {
    const current = await this.getState();
    const maintenance = current.maintenancePhase !== 'idle' && current.maintenancePhase !== 'failed';
    const usedBytes = Math.max(0, input.usedBytes);
    const capacityBytes = input.capacityBytes == null ? null : Math.max(0, input.capacityBytes);
    const diskPressure =
      capacityBytes !== null && capacityBytes > 0 && usedBytes / capacityBytes >= DEFAULT_DISK_PRESSURE_RATIO;
    const writable = input.healthy && input.writable && !maintenance && !diskPressure;
    const state = await this.store.updateState({
      status: !input.healthy
        ? 'unhealthy'
        : maintenance
          ? 'maintenance'
          : diskPressure
            ? 'degraded'
            : writable
              ? 'ready'
              : 'read_only',
      writable,
      storageUsedBytes: usedBytes,
      storageCapacityBytes: capacityBytes,
      lastError: !input.healthy
        ? 'Registry health report marked the service unhealthy'
        : diskPressure
          ? 'Registry storage is at or above the write-admission threshold'
          : null,
    });
    this.emitChanged('health', state);
    return state;
  }

  async updateSettings(input: DockerInternalRegistrySettingsInput, userId: string): Promise<RegistryState> {
    if (input.externalAccessEnabled) {
      await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('git-push-to-deploy');
    }
    const current = await this.getState();
    const previous: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: current.externalAccessEnabled,
      externalHostname: current.externalHostname,
      externalNginxNodeId: current.externalNginxNodeId,
      externalCertificateId: current.externalCertificateId,
    };
    const next: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: input.externalAccessEnabled,
      externalHostname: input.externalAccessEnabled ? input.externalHostname! : null,
      externalNginxNodeId: input.externalAccessEnabled ? input.externalNginxNodeId! : null,
      externalCertificateId: input.externalAccessEnabled ? input.externalCertificateId! : null,
    };
    if (!this.externalAccessReconciler && (next.externalAccessEnabled || previous.externalAccessEnabled)) {
      throw new AppError(503, 'REGISTRY_INGRESS_UNAVAILABLE', 'Registry ingress reconciliation is unavailable');
    }

    let state: RegistryState;
    if (next.externalAccessEnabled) {
      await this.externalAccessReconciler?.(next, previous, userId);
      state = await this.store.updateState(next);
    } else {
      state = await this.store.updateState(next);
      await this.externalAccessReconciler?.(next, previous, userId);
    }
    await this.auditService.log({
      action: 'docker.internal-registry.settings.update',
      userId,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: {
        externalAccessEnabled: state.externalAccessEnabled,
        externalHostname: state.externalHostname,
        externalNginxNodeId: state.externalNginxNodeId,
      },
    });
    this.emitChanged('settings', state);
    return state;
  }

  async disableExternalAccessForEntitlementLoss(): Promise<boolean> {
    const current = await this.getState();
    if (!current.externalAccessEnabled) return false;
    const previous: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: true,
      externalHostname: current.externalHostname,
      externalNginxNodeId: current.externalNginxNodeId,
      externalCertificateId: current.externalCertificateId,
    };
    const next: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: false,
      externalHostname: null,
      externalNginxNodeId: null,
      externalCertificateId: null,
    };
    const state = await this.store.updateState(next);
    await this.externalAccessReconciler?.(next, previous, null);
    await this.auditService.log({
      action: 'docker.internal-registry.external-access.disabled-by-license',
      userId: null,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: { previousHostname: previous.externalHostname },
    });
    this.emitChanged('license_reconciled', state);
    return true;
  }

  async assertExternalAccessEntitled(): Promise<RegistryState> {
    const state = await this.getState();
    if (!state.externalAccessEnabled) {
      throw new AppError(404, 'REGISTRY_EXTERNAL_ACCESS_DISABLED', 'Not found');
    }
    await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('git-push-to-deploy');
    return state;
  }

  private emitChanged(action: string, state: RegistryState): void {
    this.eventBus?.publish('docker.registry.changed', {
      id: INTERNAL_DOCKER_REGISTRY_ID,
      action,
      status: state.status,
      writable: state.writable,
      externalAccessEnabled: state.externalAccessEnabled,
    });
  }

  async assertBuildAdmission(): Promise<void> {
    const state = await this.getState();
    if (state.status !== 'ready' || !state.writable || state.maintenancePhase !== 'idle') {
      throw new AppError(
        503,
        'INTERNAL_REGISTRY_NOT_WRITABLE',
        'Build admission is paused because the internal registry is not writable'
      );
    }
  }

  async issueToken(input: {
    subject: string;
    service?: string;
    requested: DockerRegistryGrant[];
    allowed: DockerRegistryGrant[];
    context?: { nodeId?: string; buildId?: string; containerId?: string; deploymentId?: string };
    ttlSeconds?: number;
    externalAccess?: boolean;
  }) {
    if (input.externalAccess) await this.assertExternalAccessEntitled();
    const writeRequested = input.requested.some(
      (grant) => grant.actions.includes('push') || grant.actions.includes('delete')
    );
    if (writeRequested) {
      await this.assertBuildAdmission();
    }
    const { externalAccess: _externalAccess, ...tokenInput } = input;
    return this.tokenService.issueToken({
      ...tokenInput,
      ttlSeconds: writeRequested
        ? Math.min(input.ttlSeconds ?? MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS, MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS)
        : input.ttlSeconds,
    });
  }

  async runGarbageCollection(input: { dryRun?: boolean; requestedById?: string | null; leaseOwner?: string }) {
    const owner = input.leaseOwner ?? `registry-gc:${randomUUID()}`;
    const result = await this.executeMaintenance({ owner, dryRun: input.dryRun === true });
    await this.auditService.log({
      action: 'docker.internal-registry.gc',
      userId: input.requestedById ?? null,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: { runId: result.id, dryRun: result.dryRun, status: result.status },
    });
    return result;
  }

  async resumeMaintenance(runId: string, leaseOwner = `registry-gc:${randomUUID()}`): Promise<MaintenanceRun> {
    const run = await this.store.getRun(runId);
    if (run.status === 'completed') return run;
    return this.executeMaintenance({ owner: leaseOwner, dryRun: run.dryRun, run });
  }

  private async executeMaintenance(input: {
    owner: string;
    dryRun: boolean;
    run?: MaintenanceRun;
  }): Promise<MaintenanceRun> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS);
    await this.store.acquireLease(input.owner, leaseExpiresAt, now);
    let run = input.run
      ? await this.store.updateRun(input.run.id, {
          status: 'running',
          leaseOwner: input.owner,
          leaseExpiresAt,
          error: null,
          completedAt: null,
        })
      : await this.store.createRun(input.owner, leaseExpiresAt, input.dryRun);
    let progress = (run.progress ?? {}) as Record<string, unknown>;
    let currentPhase: DockerRegistryMaintenancePhase = 'acquiring_lease';
    let writesRestored = input.dryRun;

    const phase = async (next: DockerRegistryMaintenancePhase) => {
      currentPhase = next;
      const renewedUntil = new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS);
      await this.store.renewLease(input.owner, renewedUntil);
      run = await this.store.updateRun(run.id, { phase: next, progress, leaseExpiresAt: renewedUntil });
      await this.store.updateState({ maintenancePhase: next, status: 'maintenance', writable: false });
    };

    try {
      if (!input.dryRun) {
        await phase('pausing_admission');
        await this.executor.pauseAdmissions();
        await phase('draining_uploads');
        await this.executor.drainUploads();
      }

      await phase('computing_pins');
      const artifacts = await this.store.listRetentionArtifacts(now);
      const retention = selectRegistryRetentionCandidates(artifacts);
      progress = {
        ...progress,
        retainedArtifactIds: retention.retained.map((artifact) => artifact.id),
        candidateArtifactIds: retention.candidates.map((artifact) => artifact.id),
      };
      run = await this.store.updateRun(run.id, { progress });

      if (!input.dryRun) {
        await phase('deleting_manifests');
        for (const artifact of retention.candidates) {
          await this.store.renewLease(input.owner, new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS));
          await this.executor.deleteManifest(artifact.repository, artifact.digest);
          await this.store.markArtifactDeleted(artifact.id, new Date());
        }
        await phase('entering_read_only');
        await this.executor.enterReadOnly();
        await phase('collecting_blobs');
        await this.executor.collectGarbage();
        await phase('verifying');
        await this.executor.verifyIntegrity(
          retention.retained.map((artifact) => ({ repository: artifact.repository, digest: artifact.digest }))
        );
        await phase('restoring_writes');
        await this.executor.restoreWrites();
        writesRestored = true;
      }

      run = await this.store.updateRun(run.id, {
        phase: 'idle',
        status: 'completed',
        progress,
        error: null,
        completedAt: new Date(),
      });
      await this.store.updateState({
        status: 'ready',
        writable: true,
        maintenancePhase: 'idle',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastGcAt: new Date(),
        lastError: null,
      });
      return run;
    } catch (error) {
      let restoreError: unknown;
      if (!writesRestored) {
        try {
          await this.executor.restoreWrites();
          writesRestored = true;
        } catch (caught) {
          restoreError = caught;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const restoreMessage =
        restoreError instanceof Error ? restoreError.message : restoreError ? String(restoreError) : null;
      progress = { ...progress, failedPhase: currentPhase, restoredAfterFailure: writesRestored };
      await this.store.updateRun(run.id, {
        phase: 'failed',
        status: 'failed',
        progress,
        error: restoreMessage ? `${message}; write restoration failed: ${restoreMessage}` : message,
      });
      await this.store.updateState({
        status: writesRestored ? 'degraded' : 'unhealthy',
        writable: writesRestored,
        maintenancePhase: 'failed',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: restoreMessage ? `${message}; write restoration failed: ${restoreMessage}` : message,
      });
      throw error;
    }
  }
}
