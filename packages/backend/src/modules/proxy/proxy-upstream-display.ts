import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments } from '@/db/schema/docker-deployments.js';
import { nodes } from '@/db/schema/nodes.js';

export type WithDockerUpstreamDisplay<T> = T & {
  dockerDeploymentName: string | null;
  dockerNodeSlug: string | null;
  dockerNodeAppearanceColor: string | null;
  secureLinkActive: boolean;
};

export async function attachDockerUpstreamDisplay<
  T extends { dockerDeploymentId: string | null; dockerNodeId: string | null },
>(db: DrizzleClient, hosts: T[]): Promise<Array<WithDockerUpstreamDisplay<T>>> {
  const deploymentIds = [
    ...new Set(hosts.flatMap((host) => (host.dockerDeploymentId ? [host.dockerDeploymentId] : []))),
  ];
  const nodeIds = [...new Set(hosts.flatMap((host) => (host.dockerNodeId ? [host.dockerNodeId] : [])))];

  const [deployments, dockerNodes] = await Promise.all([
    deploymentIds.length > 0
      ? db
          .select({ id: dockerDeployments.id, name: dockerDeployments.name })
          .from(dockerDeployments)
          .where(inArray(dockerDeployments.id, deploymentIds))
      : [],
    nodeIds.length > 0
      ? db
          .select({ id: nodes.id, slug: nodes.slug, appearanceColor: nodes.appearanceColor })
          .from(nodes)
          .where(inArray(nodes.id, nodeIds))
      : [],
  ]);
  const names = new Map(deployments.map((deployment) => [deployment.id, deployment.name]));
  const slugs = new Map(dockerNodes.map((node) => [node.id, node.slug]));
  const colors = new Map(dockerNodes.map((node) => [node.id, node.appearanceColor]));
  return hosts.map((host) => {
    const visible = { ...host } as Record<string, unknown>;
    const secureLinkActive = visible.secureLinkStatus === 'active';
    if ((visible.upstreamKind as string | undefined)?.startsWith('docker_')) {
      visible.forwardHost = null;
      visible.forwardPort = null;
      visible.dockerHostPort = null;
    }
    for (const key of [
      'secureLinkGeneration',
      'secureLinkStatus',
      'secureLinkLastError',
      'secureLinkTargetNetwork',
      'secureLinkTargetContainer',
      'secureLinkTargetHost',
      'secureLinkListenerPort',
      'secureLinkConnectorPort',
      'secureLinkMigratedAt',
    ]) {
      delete visible[key];
    }
    return {
      ...visible,
      secureLinkActive,
      dockerDeploymentName: host.dockerDeploymentId ? (names.get(host.dockerDeploymentId) ?? null) : null,
      dockerNodeSlug: host.dockerNodeId ? (slugs.get(host.dockerNodeId) ?? null) : null,
      dockerNodeAppearanceColor: host.dockerNodeId ? (colors.get(host.dockerNodeId) ?? null) : null,
    } as WithDockerUpstreamDisplay<T>;
  });
}
