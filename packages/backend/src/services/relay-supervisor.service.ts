import * as grpc from '@grpc/grpc-js';
import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { RelayControlClient, RelayHealthResponse } from '@/grpc/relay-control.client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from './cache.service.js';
import type { EventBusService } from './event-bus.service.js';
import {
  type RelayDockerRecoveryService,
  type RelayRecoveryAction,
  RelayRecoverySafetyError,
} from './relay-docker-recovery.service.js';

const logger = createChildLogger('RelaySupervisor');
const CONTROL_STATE_KEY = 'relay:control-state';
const MAX_ATTEMPTS = 3;

export const RELAY_HEALTH_REASONS = [
  'unreachable',
  'tls_unavailable',
  'database_unavailable',
  'listener_unavailable',
  'app_grpc_unavailable',
  'contract_mismatch',
  'unexpected_image',
  'docker_unavailable',
  'ownership_unverified',
] as const;
export type RelayHealthReason = (typeof RELAY_HEALTH_REASONS)[number];
export type RelayLifecycleState =
  | 'migration_pending'
  | 'maintenance'
  | 'healthy'
  | 'suspect'
  | 'recovering'
  | 'critical';

export interface RelayAttemptRecord {
  attempt: number;
  startedAt: string;
  action?: RelayRecoveryAction;
  result: 'running' | 'failed' | 'healthy';
}

export interface RelaySupervisorState {
  state: RelayLifecycleState;
  reason: RelayHealthReason | null;
  attempt: number;
  maxAttempts: 3;
  attemptHistory: RelayAttemptRecord[];
  lastHealthyAt: string | null;
  lastProbeAt: string | null;
  relayVersion: string | null;
  protocolVersion: number | null;
  databaseContractVersion: number | null;
}

export interface RelaySupervisorOptions {
  required: boolean;
  managed: boolean;
  expectedImage: string | null;
  expectedService: string;
  expectedVersion?: string;
  probeIntervalMs?: number;
  recoveryDelaysMs?: readonly [number, number, number];
  readinessWaitMs?: number;
  readinessPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type ProbeResult = { healthy: true; response: RelayHealthResponse } | { healthy: false; reason: RelayHealthReason };

function isRelayHealthReason(value: string): value is RelayHealthReason {
  return (RELAY_HEALTH_REASONS as readonly string[]).includes(value);
}

function defaultState(): RelaySupervisorState {
  return {
    state: 'migration_pending',
    reason: null,
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    attemptHistory: [],
    lastHealthyAt: null,
    lastProbeAt: null,
    relayVersion: null,
    protocolVersion: null,
    databaseContractVersion: null,
  };
}

export class RelaySupervisorService {
  private state = defaultState();
  private failureCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private recoveryCycle: Promise<void> | null = null;
  private manualRetryStarting = false;
  private stopping = false;
  private readonly probeIntervalMs: number;
  private readonly recoveryDelaysMs: readonly [number, number, number];
  private readonly readinessWaitMs: number;
  private readonly readinessPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: Pick<CacheService, 'get' | 'set'>,
    private readonly relayClient: Pick<RelayControlClient, 'getHealth'> | null,
    private readonly recovery: RelayDockerRecoveryService | null,
    private readonly settings: GeneralSettingsService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly options: RelaySupervisorOptions
  ) {
    this.probeIntervalMs = options.probeIntervalMs ?? 5_000;
    this.recoveryDelaysMs = options.recoveryDelaysMs ?? [0, 10_000, 30_000];
    this.readinessWaitMs = options.readinessWaitMs ?? 20_000;
    this.readinessPollMs = options.readinessPollMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<void> {
    if (!this.options.required || !this.relayClient) return;
    this.stopping = false;
    const persisted = await this.cache.get<RelaySupervisorState>(CONTROL_STATE_KEY).catch(() => null);
    if (persisted?.maxAttempts === MAX_ATTEMPTS) this.state = persisted;
    const resumeRecovery = this.state.state === 'recovering';
    await this.probeNow();
    if (resumeRecovery && this.state.state === 'recovering') {
      this.recoveryCycle = this.runRecoveryCycle(false).finally(() => {
        this.recoveryCycle = null;
      });
    }
    this.timer = setInterval(() => void this.probeNow(), this.probeIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.recoveryCycle;
    while (this.probing) await this.sleep(25);
  }

  getSnapshot(admin: boolean) {
    if (!this.options.required) return null;
    const generic = {
      state: this.state.state,
      impact:
        this.state.state === 'critical'
          ? 'Managed nodes and secure database connections are disconnected.'
          : this.state.state === 'recovering'
            ? 'Secure database connections are temporarily unavailable.'
            : null,
      attempt: this.state.attempt,
      maxAttempts: this.state.maxAttempts,
      lastHealthyAt: this.state.lastHealthyAt,
    };
    if (!admin) return generic;
    return {
      ...generic,
      reason: this.state.reason,
      lastProbeAt: this.state.lastProbeAt,
      attemptHistory: this.state.attemptHistory,
      relayVersion: this.state.relayVersion,
      protocolVersion: this.state.protocolVersion,
      databaseContractVersion: this.state.databaseContractVersion,
      expectedService: this.options.expectedService,
      expectedVersion: this.options.expectedVersion ?? null,
      expectedImage: this.options.expectedImage,
      canRetry:
        this.state.state === 'critical' &&
        this.state.reason !== null &&
        this.isRecoverable(this.state.reason) &&
        !this.recoveryCycle &&
        !this.manualRetryStarting,
    };
  }

  async probeNow(): Promise<void> {
    if (
      this.stopping ||
      !this.options.required ||
      !this.relayClient ||
      this.probing ||
      this.state.state === 'maintenance'
    )
      return;
    this.probing = true;
    try {
      const result = await this.checkRelay();
      this.state.lastProbeAt = new Date().toISOString();
      if (result.healthy) {
        this.failureCount = 0;
        const lastHealthyMs = Number(result.response.lastHealthyAtUnixMs);
        const healthyUpdate = {
          lastHealthyAt:
            Number.isFinite(lastHealthyMs) && lastHealthyMs > 0
              ? new Date(lastHealthyMs).toISOString()
              : new Date().toISOString(),
          relayVersion: result.response.relayVersion,
          protocolVersion: Number(result.response.protocolVersion),
          databaseContractVersion: Number(result.response.databaseContractVersion),
        };
        if (this.state.state === 'healthy') {
          this.state = { ...this.state, ...healthyUpdate };
          return;
        }
        await this.transition({
          state: 'healthy',
          reason: null,
          attempt: 0,
          attemptHistory: [],
          ...healthyUpdate,
        });
        return;
      }
      this.failureCount += 1;
      if (this.failureCount === 1) {
        if (this.state.state !== 'critical' && this.state.state !== 'recovering') {
          await this.transition({ state: 'suspect', reason: result.reason });
        }
        return;
      }
      if (this.state.state === 'recovering' || this.state.state === 'critical' || this.recoveryCycle) return;
      const autoRecovery = (await this.settings.getConfig()).relayAutoRecovery;
      if (this.isRecoverable(result.reason) && autoRecovery && this.options.managed && this.recovery) {
        await this.transition({ state: 'recovering', reason: result.reason, attempt: 0, attemptHistory: [] });
        this.recoveryCycle = this.runRecoveryCycle(false).finally(() => {
          this.recoveryCycle = null;
        });
        return;
      }
      await this.transition({ state: 'critical', reason: result.reason });
    } catch {
      await this.transition({ state: 'critical', reason: 'ownership_unverified' }).catch(() => {});
    } finally {
      this.probing = false;
    }
  }

  async retryRecovery(userId: string): Promise<ReturnType<RelaySupervisorService['getSnapshot']>> {
    if (!this.options.required || !this.relayClient) throw new Error('Gateway relay is not enabled');
    if (
      this.recoveryCycle ||
      this.manualRetryStarting ||
      this.state.state !== 'critical' ||
      !this.state.reason ||
      !this.isRecoverable(this.state.reason)
    ) {
      return this.getSnapshot(true);
    }
    // Never race a periodic health check with a mutating recovery request. A
    // caller can retry after that check publishes its result.
    if (this.probing) return this.getSnapshot(true);
    this.manualRetryStarting = true;
    this.probing = true;
    try {
      // A critical snapshot can be stale when the relay recovered outside the
      // supervisor. Re-probe before any mutating Docker action so the manual
      // endpoint cannot restart an already healthy relay.
      const current = await this.checkRelay();
      this.state.lastProbeAt = new Date().toISOString();
      if (current.healthy) {
        this.failureCount = 0;
        const lastHealthyMs = Number(current.response.lastHealthyAtUnixMs);
        await this.transition({
          state: 'healthy',
          reason: null,
          attempt: 0,
          attemptHistory: [],
          lastHealthyAt:
            Number.isFinite(lastHealthyMs) && lastHealthyMs > 0
              ? new Date(lastHealthyMs).toISOString()
              : new Date().toISOString(),
          relayVersion: current.response.relayVersion,
          protocolVersion: Number(current.response.protocolVersion),
          databaseContractVersion: Number(current.response.databaseContractVersion),
        });
        return this.getSnapshot(true);
      }
      await this.transition({ state: 'critical', reason: current.reason });
      if (!this.isRecoverable(current.reason)) return this.getSnapshot(true);
      await this.transition({ state: 'recovering', attempt: 0, attemptHistory: [] });
      await this.audit.log({
        userId,
        action: 'relay.recovery.retry',
        resourceType: 'system',
        resourceId: 'gateway-relay',
        details: { maxAttempts: MAX_ATTEMPTS },
      });
      this.recoveryCycle = this.runRecoveryCycle(true).finally(() => {
        this.recoveryCycle = null;
      });
      return this.getSnapshot(true);
    } finally {
      this.probing = false;
      this.manualRetryStarting = false;
    }
  }

  async setMaintenance(enabled: boolean): Promise<void> {
    if (!this.options.required) return;
    await this.transition({ state: enabled ? 'maintenance' : 'migration_pending', reason: null });
  }

  private async runRecoveryCycle(manual: boolean): Promise<void> {
    if (!this.recovery) {
      await this.transition({ state: 'critical', reason: 'ownership_unverified' });
      return;
    }
    const startAttempt = Math.max(1, this.state.attempt + 1);
    for (let attempt = startAttempt; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.stopping) return;
      const delay = this.recoveryDelaysMs[attempt - 1] ?? 0;
      if (delay > 0) await this.sleep(delay);
      if (this.stopping) return;
      const startedAt = new Date().toISOString();
      await this.allocateAttempt(attempt, startedAt);
      let action: RelayRecoveryAction;
      try {
        action = await this.recovery.recover();
        this.updateAttempt(attempt, { action });
        await this.persistAndPublish();
      } catch (error) {
        this.updateAttempt(attempt, { result: 'failed' });
        if (error instanceof RelayRecoverySafetyError) {
          await this.transition({ state: 'critical', reason: error.reason });
          return;
        }
        await this.persistAndPublish();
        continue;
      }
      const healthy = await this.waitForReadiness();
      if (healthy) {
        this.updateAttempt(attempt, { result: 'healthy' });
        await this.transition({ state: 'healthy', reason: null, attempt: 0, attemptHistory: [] });
        await this.audit.log({
          userId: null,
          action: 'relay.recovery.succeeded',
          resourceType: 'system',
          resourceId: 'gateway-relay',
          details: { attempt, action, manual },
        });
        return;
      }
      this.updateAttempt(attempt, { result: 'failed' });
      await this.persistAndPublish();
    }
    await this.transition({ state: 'critical', reason: this.state.reason ?? 'unreachable' });
    await this.audit.log({
      userId: null,
      action: 'relay.recovery.failed',
      resourceType: 'system',
      resourceId: 'gateway-relay',
      details: { attempts: MAX_ATTEMPTS, manual },
    });
  }

  private async allocateAttempt(attempt: number, startedAt: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-recovery'))`);
      this.state = {
        ...this.state,
        state: 'recovering',
        attempt,
        attemptHistory: [
          ...this.state.attemptHistory.filter((record) => record.attempt !== attempt),
          { attempt, startedAt, result: 'running' },
        ],
      };
      await this.cache.set(CONTROL_STATE_KEY, this.state);
    });
    this.publish();
  }

  private updateAttempt(attempt: number, update: Partial<RelayAttemptRecord>): void {
    this.state.attemptHistory = this.state.attemptHistory.map((record) =>
      record.attempt === attempt ? { ...record, ...update } : record
    );
  }

  private async waitForReadiness(): Promise<boolean> {
    const deadline = Date.now() + this.readinessWaitMs;
    while (Date.now() < deadline) {
      const result = await this.checkRelay();
      if (result.healthy) return true;
      await this.sleep(this.readinessPollMs);
    }
    return false;
  }

  private async checkRelay(): Promise<ProbeResult> {
    if (!this.relayClient) return { healthy: false, reason: 'unreachable' };
    try {
      const response = await this.relayClient.getHealth(2_000);
      if (!response.liveness) return { healthy: false, reason: 'listener_unavailable' };
      if (!response.readiness || !response.dataPlaneHealthy) {
        return {
          healthy: false,
          reason: isRelayHealthReason(response.reason) ? response.reason : 'database_unavailable',
        };
      }
      if (!response.appProxyHealthy) return { healthy: false, reason: 'app_grpc_unavailable' };
      if (this.options.expectedVersion && response.relayVersion !== this.options.expectedVersion) {
        return { healthy: false, reason: 'contract_mismatch' };
      }
      return { healthy: true, response };
    } catch (error) {
      const grpcError = error as { code?: number; message?: string };
      if (
        grpcError.code === grpc.status.PERMISSION_DENIED ||
        grpcError.code === grpc.status.UNAUTHENTICATED ||
        /(?:tls|ssl|certificate|handshake)/i.test(grpcError.message ?? '')
      ) {
        return { healthy: false, reason: 'tls_unavailable' };
      }
      return { healthy: false, reason: 'unreachable' };
    }
  }

  private isRecoverable(reason: RelayHealthReason): boolean {
    return reason === 'unreachable' || reason === 'listener_unavailable';
  }

  private async transition(update: Partial<RelaySupervisorState>): Promise<void> {
    const changed = Object.entries(update).some(
      ([key, value]) => this.state[key as keyof RelaySupervisorState] !== value
    );
    this.state = { ...this.state, ...update };
    if (!changed) return;
    await this.persistAndPublish();
    logger.info('Gateway relay supervisor state changed', {
      state: this.state.state,
      reason: this.state.reason,
      attempt: this.state.attempt,
    });
  }

  private async persistAndPublish(): Promise<void> {
    await this.cache.set(CONTROL_STATE_KEY, this.state);
    this.publish();
  }

  private publish(): void {
    this.events.publish('system.relay.health.changed', {
      state: this.state.state,
      reason: this.state.reason,
      attempt: this.state.attempt,
    });
  }
}
