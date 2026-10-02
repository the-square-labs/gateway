import { AppError } from '@/middleware/error-handler.js';
import { resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import type { HostApplyOptions } from '@/services/nginx-certificate-distribution.service.js';
import { type CertPathOptions, logger, type ProxyHostRow, ProxyServiceCore } from './proxy.service.core.js';
import {
  forgetIngressMemberDeliveries,
  INGRESS_MEMBER_OFFLINE_MESSAGE,
  IngressDeliveryError,
  type IngressMemberFailure,
  ingressConfigHash,
  markIngressMemberDelivery,
} from './proxy-ingress-delivery.js';

export interface HostDeliveryOptions {
  certOptions?: CertPathOptions;
  pagesRouteIncludePathOverride?: string;
  /** Deliver only to these serving nodes (reconnect resync, member add, convergence). Group routes only. */
  nodeIds?: string[];
  /** How the config reaches the node (the reconnect resync defers the reload and keeps the active bundle). */
  apply?: HostApplyOptions;
}

export interface HostDeliveryResult {
  /** The config applied on the first node that took it (the only node for a single-node route). */
  config: string;
  configOwnership: string;
  epoch: number;
  /** Config applied per node. */
  configs: Map<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Delivery of a route to the nginx nodes that serve it. A single-node route is rendered and applied exactly as
 * before. A route on an ingress group is rendered per member (certificate paths, listener fallbacks and maintenance
 * access differ per node) and applied to every connected member; offline members are recorded as pending and
 * converge when they reconnect.
 */
export abstract class ProxyServiceDelivery extends ProxyServiceCore {
  /** The nodes that serve a route, in site-preference order (see resolveIngressNodes). */
  protected async ingressNodesOf(host: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'>): Promise<string[]> {
    return resolveIngressNodes(this.db, host);
  }

  protected async deliverHost(host: ProxyHostRow, options: HostDeliveryOptions = {}): Promise<HostDeliveryResult> {
    const configOwnership = this.configOwnershipForHost(host);
    if (!host.ingressGroupId) {
      const certPaths = await this.resolveCertPaths(host, options.certOptions);
      const accessList = await this.resolveAccessList(host.accessListId);
      const config = await this.buildNginxConfig(host, certPaths, accessList, options.pagesRouteIncludePathOverride);
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        configOwnership,
        host.accessListId,
        options.apply
      );
      const nodeId = certPaths.preparedTls?.nodeId ?? host.nodeId ?? '';
      return {
        config,
        configOwnership,
        epoch: this.hostConfigEpochs.get(host.id) ?? 0,
        configs: new Map([[nodeId, config]]),
      };
    }

    const members = options.nodeIds ?? (await this.ingressNodesOf(host));
    if (members.length === 0) {
      throw new AppError(409, 'INGRESS_GROUP_EMPTY', 'The ingress group of this route has no members');
    }
    const accessList = await this.resolveAccessList(host.accessListId);
    const configs = new Map<string, string>();
    const failures: IngressMemberFailure[] = [];
    const offline: string[] = [];
    for (const nodeId of members) {
      if (!this.nodeDispatch.isNodeConnected(nodeId)) {
        offline.push(nodeId);
        await markIngressMemberDelivery(this.db, host.id, nodeId, {
          status: 'pending',
          lastError: INGRESS_MEMBER_OFFLINE_MESSAGE,
        });
        continue;
      }
      const memberHost: ProxyHostRow = { ...host, nodeId };
      try {
        const certPaths = await this.resolveCertPaths(memberHost, options.certOptions);
        const config = await this.buildNginxConfig(
          memberHost,
          certPaths,
          accessList,
          options.pagesRouteIncludePathOverride
        );
        const desired = {
          desiredConfigHash: ingressConfigHash(config),
          desiredCertificateVersion: certPaths.preparedTls?.version ?? null,
        };
        await markIngressMemberDelivery(this.db, host.id, nodeId, {
          ...desired,
          status: 'pending',
          lastError: null,
          attemptedAt: new Date(),
        });
        await this.applyConfigToNode(
          host.id,
          config,
          nodeId,
          certPaths.preparedTls,
          configOwnership,
          host.accessListId,
          options.apply
        );
        await markIngressMemberDelivery(this.db, host.id, nodeId, {
          ...desired,
          appliedConfigHash: desired.desiredConfigHash,
          appliedCertificateVersion: desired.desiredCertificateVersion,
          status: 'ready',
          lastError: null,
          appliedAt: new Date(),
        });
        configs.set(nodeId, config);
      } catch (error) {
        failures.push({ nodeId, message: errorMessage(error) });
        await markIngressMemberDelivery(this.db, host.id, nodeId, {
          status: 'failed',
          lastError: errorMessage(error).slice(0, 1000),
          attemptedAt: new Date(),
        }).catch(() => undefined);
      }
    }
    if (failures.length > 0 || configs.size === 0) {
      throw new IngressDeliveryError(host.id, [...configs.keys()], failures, offline);
    }
    if (offline.length > 0) {
      logger.info('Applied a group route on its connected members; offline members converge on reconnect', {
        hostId: host.id,
        offlineNodeIds: offline,
      });
    }
    const [first] = configs.values();
    return { config: first!, configOwnership, epoch: this.hostConfigEpochs.get(host.id) ?? 0, configs };
  }

  /**
   * Removes a route's config from the nodes that serve it and retires their certificate deployments. A single-node
   * route behaves as before (an unreachable node fails the call). On a group, an offline member is skipped: its stale
   * config is removed by the full sync that follows its reconnect resync.
   */
  protected async withdrawHost(
    host: Pick<ProxyHostRow, 'id' | 'nodeId' | 'ingressGroupId'>,
    options: { nodeIds?: string[] } = {}
  ): Promise<void> {
    if (!host.ingressGroupId && !options.nodeIds) {
      await this.removeConfigFromNode(host.id, host.nodeId);
      await this.certificateDistribution.deactivateHost(host.id, host.nodeId);
      return;
    }
    const members = options.nodeIds ?? (await this.ingressNodesOf(host));
    const failures: IngressMemberFailure[] = [];
    const withdrawn: string[] = [];
    for (const nodeId of members) {
      try {
        if (this.nodeDispatch.isNodeConnected(nodeId)) await this.removeConfigFromNode(host.id, nodeId);
        await this.certificateDistribution.deactivateHost(host.id, nodeId);
        withdrawn.push(nodeId);
      } catch (error) {
        failures.push({ nodeId, message: errorMessage(error) });
      }
    }
    await forgetIngressMemberDeliveries(this.db, host.id, { nodeIds: withdrawn });
    if (failures.length > 0) throw new IngressDeliveryError(host.id, [], failures, []);
  }
}
