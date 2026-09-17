import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { INTERNAL_REGISTRY_INGRESS_ID } from '@/modules/docker/docker-registry.constants.js';
import type {
  DockerInternalRegistryService,
  DockerRegistryExternalAccessConfig,
} from '@/modules/docker/docker-registry-internal.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';

export class RelayRegistryIngressService {
  private reconcileChain: Promise<void> = Promise.resolve();

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
      void this.registry
        .getState()
        .then((state) => {
          if (state.externalAccessEnabled && state.externalNginxNodeId === event.id) {
            return this.reconcile(this.fromState(state), this.fromState(state), null);
          }
        })
        .catch(() => undefined);
    });
  }

  start(): void {
    void this.registry
      .getState()
      .then((state) => this.reconcile(this.fromState(state), this.fromState(state), null))
      .catch(() => undefined);
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
