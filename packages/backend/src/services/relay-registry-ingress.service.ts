import {
  INTERNAL_REGISTRY_INGRESS_ID,
  INTERNAL_REGISTRY_INGRESS_PORT,
} from '@/modules/docker/docker-registry.constants.js';
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
  private generation = Date.now();

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

  private async reconcileLocked(
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
    if (!next.externalHostname || !next.externalNginxNodeId || !next.externalCertificateId) {
      throw new Error('External registry hostname, Nginx node, and certificate are required');
    }

    await this.relayPolicy.ensureInternalRegistryRoute(
      INTERNAL_REGISTRY_INGRESS_ID,
      next.externalNginxNodeId,
      'registry_ingress'
    );
    try {
      await this.syncNode(next.externalNginxNodeId, [this.binding()]);
      await this.proxy.upsertRegistrySystemHost(
        {
          domain: next.externalHostname,
          nodeId: next.externalNginxNodeId,
          sslCertificateId: next.externalCertificateId,
        },
        userId
      );
      if (
        previous.externalAccessEnabled &&
        previous.externalNginxNodeId &&
        previous.externalNginxNodeId !== next.externalNginxNodeId
      ) {
        await this.syncNode(previous.externalNginxNodeId, []);
      }
    } catch (error) {
      await this.syncNode(next.externalNginxNodeId, []).catch(() => undefined);
      await this.relayPolicy
        .revokeOwner('registry_ingress', INTERNAL_REGISTRY_INGRESS_ID, { allowDeferredSnapshot: true })
        .catch(() => undefined);
      throw error;
    }
  }

  private async syncNode(nodeId: string, bindings: ReturnType<RelayRegistryIngressService['binding']>[]) {
    const result = await this.dispatch.sendNginxRegistryBindings(nodeId, bindings);
    if (!result.success) throw new Error(result.error || 'Nginx daemon rejected registry ingress bindings');
  }

  private binding() {
    this.generation += 1;
    return {
      bindingId: INTERNAL_REGISTRY_INGRESS_ID,
      role: 'ingress' as const,
      generation: this.generation,
      repository: '*' as const,
      actions: ['pull', 'push'] as ['pull', 'push'],
      localAddress: '127.0.0.1' as const,
      localPort: INTERNAL_REGISTRY_INGRESS_PORT,
      relayOwnerKind: 'registry_ingress' as const,
      relayOwnerId: INTERNAL_REGISTRY_INGRESS_ID,
      authorization: '' as const,
      authorizationExpiresAtUnix: 0 as const,
    };
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
