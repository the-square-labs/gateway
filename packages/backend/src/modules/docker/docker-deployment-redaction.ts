import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { redactDeploymentWebhookToken } from './docker-deployment-helpers.js';

type ConfigWithEnv = { env?: unknown; [key: string]: unknown } | null | undefined;

function withoutEnv<T extends ConfigWithEnv>(config: T): T {
  if (!config || typeof config !== 'object' || !('env' in config)) return config;
  const { env: _env, ...rest } = config;
  return rest as T;
}

/**
 * Removes environment values from a deployment detail: the desired config and
 * the config snapshots kept per slot and release. Secrets have their own
 * endpoint; plain env is only returned to callers holding
 * `docker:containers:environment`.
 */
export function redactDeploymentEnvironment<T>(deployment: T, canViewEnvironment: boolean): T {
  if (canViewEnvironment || !deployment || typeof deployment !== 'object') return deployment;
  const record = deployment as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...record };
  if ('desiredConfig' in record) redacted.desiredConfig = withoutEnv(record.desiredConfig as ConfigWithEnv);
  for (const key of ['slots', 'releases'] as const) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    redacted[key] = items.map((item) =>
      item && typeof item === 'object' && 'desiredConfig' in item
        ? { ...item, desiredConfig: withoutEnv((item as { desiredConfig: ConfigWithEnv }).desiredConfig) }
        : item
    );
  }
  return redacted as T;
}

/** Shapes a deployment detail for one caller: webhook token and env by permission. */
export function presentDeploymentForCaller<T>(
  deployment: T,
  scopes: string[],
  nodeId: string,
  deploymentId: string
): T {
  if (!deployment || typeof deployment !== 'object') return deployment;
  const canViewEnvironment = hasDockerResourceScope(scopes, 'docker:containers:environment', nodeId, deploymentId);
  const canRevealWebhookToken = hasDockerResourceScope(scopes, 'docker:containers:webhooks', nodeId, deploymentId);
  const redacted = redactDeploymentEnvironment(deployment, canViewEnvironment) as T & {
    webhook?: { token?: string; [key: string]: unknown } | null;
  };
  return redactDeploymentWebhookToken(redacted, canRevealWebhookToken);
}
