import type { DockerDeploymentHealthConfig, DockerDeploymentSlot } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerDeploymentCreateInput } from './docker-deployment.schemas.js';

export type DeploymentRouteShape = Pick<
  DockerDeploymentCreateInput['routes'][number],
  'hostPort' | 'containerPort' | 'isPrimary'
>;

export function inactiveSlot(slot: DockerDeploymentSlot): DockerDeploymentSlot {
  return slot === 'blue' ? 'green' : 'blue';
}

export function shortId(id: string) {
  return id.replace(/-/g, '').slice(0, 12);
}

export function normalizeRoutes(routes: DockerDeploymentCreateInput['routes']) {
  const primaryCount = routes.filter((route) => route.isPrimary).length;
  if (primaryCount !== 1) throw new AppError(400, 'INVALID_ROUTES', 'Exactly one route must be primary');
  const hostPorts = new Set<number>();
  for (const route of routes) {
    if (hostPorts.has(route.hostPort)) {
      throw new AppError(400, 'INVALID_ROUTES', `Host port ${route.hostPort} is duplicated`);
    }
    hostPorts.add(route.hostPort);
  }
  return routes;
}

export function deploymentRoutesEqual(current: DeploymentRouteShape[], next: DeploymentRouteShape[]) {
  if (current.length !== next.length) return false;
  const serialize = (routes: DeploymentRouteShape[]) =>
    routes
      .map((route) => `${route.hostPort}:${route.containerPort}:${route.isPrimary ? '1' : '0'}`)
      .sort()
      .join('|');
  return serialize(current) === serialize(next);
}

export function normalizeHealth(health: DockerDeploymentHealthConfig): DockerDeploymentHealthConfig {
  if (health.statusMin > health.statusMax) {
    throw new AppError(400, 'INVALID_HEALTH', 'Minimum healthy status cannot be greater than maximum status');
  }
  return health;
}

export function isBusyDeploymentStatus(status: string) {
  return (
    status === 'creating' ||
    status === 'deploying' ||
    status === 'switching' ||
    status === 'deleting' ||
    status === 'starting' ||
    status === 'stopping' ||
    status === 'restarting' ||
    status === 'killing' ||
    status === 'removing' ||
    status === 'rolling_back'
  );
}

export function imageWithTag(image: string, tag?: string) {
  if (!tag) return image;
  const atDigest = image.indexOf('@');
  const digestSuffix = atDigest >= 0 ? image.slice(atDigest) : '';
  const ref = atDigest >= 0 ? image.slice(0, atDigest) : image;
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return `${repo}:${tag}${digestSuffix}`;
}

type DeploymentWithWebhook = {
  webhook?: { token?: string; [key: string]: unknown } | null;
};

/**
 * A deployment detail is also used by the regular view endpoint. Keep webhook
 * metadata useful there, but reserve its bearer token for the webhook-scoped
 * endpoint.
 */
export function redactDeploymentWebhookToken<T extends DeploymentWithWebhook>(deployment: T, canReveal: boolean): T {
  if (canReveal || !deployment.webhook) return deployment;
  return {
    ...deployment,
    webhook: { ...deployment.webhook, token: '[REDACTED]' },
  };
}
