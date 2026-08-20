import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeploymentRoutes, dockerDeployments, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  type DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL } from '@/modules/docker/docker-deployment-labels.js';
import type { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

export type ProxyUpstreamKind = 'manual' | 'docker_container' | 'docker_deployment' | 'pages';

export interface DockerUpstreamReference {
  upstreamKind: ProxyUpstreamKind;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: string | null;
}

export interface ResolvedDockerUpstream {
  upstreamKind: Exclude<ProxyUpstreamKind, 'manual' | 'pages'>;
  forwardHost: string;
  forwardPort: number;
  dockerNodeId: string | null;
  dockerContainerName: string | null;
  dockerDeploymentId: string | null;
  dockerContainerPort: number;
  dockerHostPort: number | null;
  dockerProtocol: 'tcp';
}

interface ResolveOptions {
  actorScopes?: string[];
  requireAvailable?: boolean;
  allowPortRebind?: boolean;
}

interface SnapshotPort {
  privatePort: number;
  publicPort: number;
  type: string;
  ip: string | null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function readPorts(container: Record<string, unknown>): SnapshotPort[] {
  const raw = container.ports ?? container.Ports;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const port = entry as Record<string, unknown>;
    const privatePort = readNumber(port.privatePort ?? port.PrivatePort);
    const publicPort = readNumber(port.publicPort ?? port.PublicPort);
    if (!privatePort || !publicPort) return [];
    return [
      {
        privatePort,
        publicPort,
        type: String(port.type ?? port.Type ?? 'tcp').toLowerCase(),
        ip: typeof (port.ip ?? port.IP) === 'string' ? String(port.ip ?? port.IP) : null,
      },
    ];
  });
}

function readContainerName(container: Record<string, unknown>): string {
  return String(container.name ?? container.Name ?? '').replace(/^\/+/, '');
}

function isDeploymentInternal(container: Record<string, unknown>): boolean {
  const labels = container.labels ?? container.Labels;
  return (
    !!labels &&
    typeof labels === 'object' &&
    !Array.isArray(labels) &&
    (labels as Record<string, unknown>)[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true'
  );
}

export function clearDockerUpstreamFields() {
  return {
    dockerNodeId: null,
    dockerContainerName: null,
    dockerDeploymentId: null,
    dockerContainerPort: null,
    dockerHostPort: null,
    dockerProtocol: null,
  } as const;
}

export class ProxyDockerUpstreamService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly snapshots: DockerSnapshotService,
    private readonly registry: NodeRegistryService,
    private readonly accessResources?: DockerAccessResourceService
  ) {}

  async resolve(reference: DockerUpstreamReference, options: ResolveOptions = {}): Promise<ResolvedDockerUpstream> {
    if (reference.upstreamKind === 'docker_container') {
      return this.resolveContainer(reference, options);
    }
    if (reference.upstreamKind === 'docker_deployment') {
      return this.resolveDeployment(reference, options);
    }
    throw new AppError(400, 'INVALID_UPSTREAM', 'Docker upstream reference is required');
  }

  private assertDockerViewScope(nodeId: string, resourceId: string, actorScopes?: string[]) {
    if (actorScopes && !hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', 'Docker container access is required for this upstream');
    }
  }

  private assertDockerNodeVisibility(nodeId: string, actorScopes?: string[]) {
    if (
      actorScopes &&
      !hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, '') &&
      !dockerScopedNodeIds(actorScopes, ['docker:containers:view']).includes(nodeId)
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Docker container access is required for this upstream');
    }
  }

  private async getDockerNode(nodeId: string, options: ResolveOptions) {
    const [node] = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        status: nodes.status,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'DOCKER_NODE_NOT_FOUND', 'Docker node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Selected node is not a Docker node');
    if (options.requireAvailable && !this.registry.getNode(nodeId)) {
      throw new AppError(409, 'DOCKER_TARGET_UNAVAILABLE', 'Docker node is unavailable');
    }
    return node;
  }

  private choosePort(reference: DockerUpstreamReference, ports: SnapshotPort[]): number {
    const containerPort = reference.dockerContainerPort;
    const protocol = reference.dockerProtocol ?? 'tcp';
    if (!containerPort || protocol !== 'tcp') {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'A TCP container port is required');
    }
    // Declared ports improve the picker but are not an admission boundary:
    // Secure Links can target an explicitly entered application port even
    // when Docker does not publish it on the host.
    const declared = ports.some((port) => port.privatePort === containerPort && port.type === protocol);
    void declared;
    return containerPort;
  }

  private async resolveContainer(
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream> {
    const nodeId = reference.dockerNodeId;
    const containerName = reference.dockerContainerName?.replace(/^\/+/, '');
    if (!nodeId || !containerName) {
      throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and exact container name are required');
    }
    this.assertDockerNodeVisibility(nodeId, options.actorScopes);
    await this.getDockerNode(nodeId, options);
    const snapshot = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers');
    if (options.requireAvailable && (snapshot.revision === 0 || snapshot.refreshStatus === 'error')) {
      throw new AppError(409, 'DOCKER_TARGET_UNAVAILABLE', 'Docker container snapshot is unavailable');
    }
    const container = Array.isArray(snapshot.data)
      ? snapshot.data.find((item) => readContainerName(item) === containerName)
      : undefined;
    if (!container || isDeploymentInternal(container)) {
      throw new AppError(404, 'DOCKER_CONTAINER_NOT_FOUND', 'Docker container snapshot not found');
    }
    const runtimeId = String(container.id ?? container.Id ?? '');
    const resourceId = this.accessResources
      ? await this.accessResources.ensureContainer(nodeId, containerName, runtimeId, false)
      : '';
    this.assertDockerViewScope(nodeId, resourceId, options.actorScopes);
    const selectedPort = this.choosePort(reference, readPorts(container));
    return {
      upstreamKind: 'docker_container',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: nodeId,
      dockerContainerName: containerName,
      dockerDeploymentId: null,
      dockerContainerPort: selectedPort,
      dockerHostPort: null,
      dockerProtocol: 'tcp',
    };
  }

  private async resolveDeployment(
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream> {
    const deploymentId = reference.dockerDeploymentId;
    if (!deploymentId) throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    this.assertDockerViewScope(deployment.nodeId, deployment.id, options.actorScopes);
    await this.getDockerNode(deployment.nodeId, options);
    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    const containerPort = reference.dockerContainerPort;
    if (!containerPort || (reference.dockerProtocol ?? 'tcp') !== 'tcp') {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'A TCP deployment port is required');
    }
    const semanticMatches = routes.filter((route) => route.containerPort === containerPort);
    const route =
      semanticMatches.find((item) => item.hostPort === reference.dockerHostPort) ??
      (semanticMatches.length === 1 ? semanticMatches[0] : undefined);
    if (!route) {
      throw new AppError(
        409,
        semanticMatches.length > 1 ? 'DOCKER_PORT_AMBIGUOUS' : 'DOCKER_PORT_NOT_PUBLISHED',
        semanticMatches.length > 1
          ? 'Select one of the deployment application ports'
          : 'The selected deployment route is missing'
      );
    }
    return {
      upstreamKind: 'docker_deployment',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: deployment.nodeId,
      dockerContainerName: null,
      dockerDeploymentId: deploymentId,
      dockerContainerPort: route.containerPort,
      dockerHostPort: route.hostPort,
      dockerProtocol: 'tcp',
    };
  }
}
