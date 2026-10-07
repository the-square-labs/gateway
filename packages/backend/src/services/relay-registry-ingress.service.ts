import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { createChildLogger } from '@/lib/logger.js';
import { INTERNAL_REGISTRY_INGRESS_ID } from '@/modules/docker/docker-registry.constants.js';
import type {
  DockerInternalRegistryService,
  DockerRegistryExternalAccessConfig,
} from '@/modules/docker/docker-registry-internal.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';

const logger = createChildLogger('RelayRegistryIngressService');
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

export class RelayRegistryIngressService {
  private reconcileChain: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_MIN_MS;

  constructor(
    private readonly relayPolicy: RelayPolicyService,
    private readonly dispatch: NodeDispatchService,
    private readonly registry: DockerInternalRegistryService,
    private readonly proxy: ProxyService
  ) {}

  setEventBus(events: EventBusService): void {
    events.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; action?: unknown; status?: unknown } | null;
      if (typeof event?.id !== 'string' || event.action === 'deleted') return;
      if (event.status !== undefined && event.status !== 'online') return;
      this.reconcileCurrent(event.id);
    });
  }

  start(): void {
    this.reconcileCurrent();
  }

  /**
   * Reconciles the stored configuration, on start or when the configured Nginx node connects (`nodeId`). A failure
   * (the relay not ready yet at start, a snapshot that could not be published) is logged and retried with a backoff
   * while external access is enabled; an offline Nginx node is retried when it connects again.
   */
  private reconcileCurrent(nodeId?: string): void {
    void this.registry
      .getState()
      .then(async (state) => {
        if (nodeId !== undefined && !(state.externalAccessEnabled && state.externalNginxNodeId === nodeId)) return;
        try {
          await this.reconcile(this.fromState(state), this.fromState(state), null);
          this.retryDelayMs = RETRY_MIN_MS;
        } catch (error) {
          logger.warn('Internal registry ingress reconcile failed', {
            nginxNodeId: state.externalNginxNodeId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleRetry(state);
        }
      })
      .catch((error) => {
        logger.warn('Internal registry ingress state could not be read', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private scheduleRetry(state: DockerRegistryExternalAccessConfig): void {
    if (!state.externalAccessEnabled || this.retryTimer) return;
    if (!state.externalNginxNodeId || !this.dispatch.isNodeConnected(state.externalNginxNodeId)) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.reconcileCurrent();
    }, delay);
    this.retryTimer.unref?.();
  }

  async reconcile(
    next: DockerRegistryExternalAccessConfig,
    previous: DockerRegistryExternalAccessConfig,
    userId: string | null
  ): Promise<void> {
    const run = this.reconcileChain.catch(() => undefined).then(() => this.reconcileLocked(next, previous, userId));
    this.reconcileChain = run;
    return run;
  }

  protected async reconcileLocked(
    next: DockerRegistryExternalAccessConfig,
    previous: DockerRegistryExternalAccessConfig,
    userId: string | null
  ): Promise<void> {
    if (!next.externalAccessEnabled) {
      const removed = await this.proxy.disableRegistrySystemHost(userId);
      const oldNodeId = previous.externalNginxNodeId ?? removed?.nodeId ?? null;
      if (oldNodeId) await this.syncNode(oldNodeId, []);
      await this.relayPolicy.revokeOwner('registry_ingress', INTERNAL_REGISTRY_INGRESS_ID, {
        allowDeferredSnapshot: true,
      });
      return;
    }
    return commercialModuleUnavailable();
  }

  protected registryIngressContext() {
    return {
      relayPolicy: this.relayPolicy,
      proxy: this.proxy,
      syncNode: (nodeId: string, bindings: Parameters<NodeDispatchService['sendNginxRegistryBindings']>[1]) =>
        this.syncNode(nodeId, bindings),
    };
  }

  private async syncNode(nodeId: string, bindings: Parameters<NodeDispatchService['sendNginxRegistryBindings']>[1]) {
    const result = await this.dispatch.sendNginxRegistryBindings(nodeId, bindings);
    if (!result.success) throw new Error(result.error || 'Nginx daemon rejected registry ingress bindings');
  }

  private fromState(state: DockerRegistryExternalAccessConfig): DockerRegistryExternalAccessConfig {
    return {
      externalAccessEnabled: state.externalAccessEnabled,
      externalHostname: state.externalHostname,
      externalNginxNodeId: state.externalNginxNodeId,
      externalCertificateId: state.externalCertificateId,
    };
  }
}
