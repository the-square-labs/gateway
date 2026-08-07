import type { RelayControlClient, RelayHealthResponse } from '@/grpc/relay-control.client.js';
import { RELAY_VERSION } from '@/relay/version.js';
import {
  type RelayDockerRecoveryService,
  RelayRecoverySafetyError,
  type RelayStartupAction,
} from './relay-docker-recovery.service.js';

export interface RelayStartupFinalizerOptions {
  required: boolean;
  expectedVersion?: string;
  readinessWaitMs?: number;
  readinessPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type RelayStartupFinalizerResult =
  | { status: 'disabled'; action: null }
  | { status: 'active'; action: RelayStartupAction | null; relayVersion: string }
  | { status: 'degraded'; action: RelayStartupAction | null; reason: string };

export class RelayStartupFinalizerService {
  private readonly expectedVersion: string;
  private readonly readinessWaitMs: number;
  private readonly readinessPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: Pick<RelayControlClient, 'getHealth' | 'reloadIdentity'> | null,
    private readonly recovery: Pick<RelayDockerRecoveryService, 'ensureStarted' | 'recreateExpected'>,
    private readonly options: RelayStartupFinalizerOptions
  ) {
    this.expectedVersion = options.expectedVersion ?? RELAY_VERSION;
    this.readinessWaitMs = options.readinessWaitMs ?? 20_000;
    this.readinessPollMs = options.readinessPollMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async finalize(): Promise<RelayStartupFinalizerResult> {
    if (!this.options.required || !this.client) return { status: 'disabled', action: null };

    let action: RelayStartupAction | null = null;
    try {
      // The app may have atomically refreshed the shared service-identity files
      // while the relay kept its external listener and tunnel sessions alive.
      // Apply those files before readiness is evaluated; a missing relay is
      // handled by the normal start/recreate path below.
      await this.client.reloadIdentity().catch(() => false);
      const initial = await this.probe();
      if (initial && initial.relayVersion === this.expectedVersion) {
        return { status: 'active', action: null, relayVersion: initial.relayVersion };
      }

      if (initial && initial.relayVersion !== this.expectedVersion) {
        action = await this.recovery.recreateExpected();
      } else {
        try {
          action = await this.recovery.ensureStarted();
        } catch (error) {
          // A changed, signed relay version intentionally changes the expected
          // image. Only the startup finalizer may replace that owned old image.
          if (!(error instanceof RelayRecoverySafetyError) || error.reason !== 'unexpected_image') throw error;
          action = await this.recovery.recreateExpected();
        }
      }

      let ready = await this.waitForReadiness();
      if (ready && ready.relayVersion !== this.expectedVersion && action !== 'recreate') {
        action = await this.recovery.recreateExpected();
        ready = await this.waitForReadiness();
      }
      if (!ready) return { status: 'degraded', action, reason: 'unreachable' };
      if (ready.relayVersion !== this.expectedVersion) {
        return { status: 'degraded', action, reason: 'contract_mismatch' };
      }
      return { status: 'active', action, relayVersion: ready.relayVersion };
    } catch (error) {
      return {
        status: 'degraded',
        action,
        reason: error instanceof RelayRecoverySafetyError ? error.reason : 'unreachable',
      };
    }
  }

  private async waitForReadiness(): Promise<RelayHealthResponse | null> {
    const deadline = Date.now() + this.readinessWaitMs;
    do {
      const response = await this.probe();
      if (response) return response;
      await this.sleep(this.readinessPollMs);
    } while (Date.now() < deadline);
    return null;
  }

  private async probe(): Promise<RelayHealthResponse | null> {
    try {
      const response = await this.client!.getHealth(2_000);
      return response.liveness && response.readiness && response.dataPlaneHealthy && response.appProxyHealthy
        ? response
        : null;
    } catch {
      return null;
    }
  }
}
