import type { DockerDeploymentCreateInput } from './docker-deployment.schemas.js';
export type DeploymentRouteShape = Pick<
  DockerDeploymentCreateInput['routes'][number],
  'hostPort' | 'containerPort' | 'isPrimary'
>;
type DeploymentWithWebhook = {
  webhook?: { token?: string; [key: string]: unknown } | null;
};
export function redactDeploymentWebhookToken<T extends DeploymentWithWebhook>(deployment: T, canReveal: boolean): T {
  if (canReveal || !deployment.webhook) return deployment;
  return {
    ...deployment,
    webhook: { ...deployment.webhook, token: '[REDACTED]' },
  };
}
