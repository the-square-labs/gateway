const RECREATE_EXECUTION_FIELDS = ['image', 'entrypoint', 'command', 'user', 'runtimeProfile'] as const;

/**
 * Scopes a recreate request needs beyond docker:containers:manage. A plain
 * recreate stays on manage; changing what the container executes can expose
 * its environment and secrets, so it needs the same scopes as duplicate.
 */
export function containerRecreateRequiredScopes(config: Record<string, unknown>): string[] {
  const present = (key: string) => config[key] !== undefined;
  if (!Object.keys(config).some(present)) return [];
  const required = ['docker:containers:edit'];
  if (RECREATE_EXECUTION_FIELDS.some(present)) {
    required.push('docker:containers:environment', 'docker:containers:secrets');
  }
  return required;
}

/** A container update with a tag pulls and runs that tag (an empty tag keeps the image, as the update does). */
export function containerUpdateChangesImage(config: { tag?: unknown }): boolean {
  return typeof config.tag === 'string' && config.tag.length > 0;
}

/**
 * Scopes a container update (pull + redeploy) needs beyond docker:containers:edit. A new tag runs other code with the
 * container's env and secrets, like a recreate with a new image (the caller also checks docker:images:pull).
 */
export function containerUpdateRequiredScopes(config: { tag?: unknown; env?: unknown; removeEnv?: unknown }): string[] {
  if (containerUpdateChangesImage(config)) return ['docker:containers:environment', 'docker:containers:secrets'];
  return config.env !== undefined || config.removeEnv !== undefined ? ['docker:containers:environment'] : [];
}

const DEPLOYMENT_EXECUTION_FIELDS = ['image', 'command', 'entrypoint', 'user', 'runtimeProfile'] as const;
const DEPLOYMENT_EXECUTION_SCOPES = [
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:secrets',
] as const;

/**
 * What a deployment change needs beyond its route scope, on the deployment, and whether the node must also allow
 * `docker:images:pull`. Every rollout starts the new slot with the deployment's env and secrets, so changing what the
 * slots execute needs the scopes of a container recreate with a new image; replacing the env needs environment.
 */
export interface DeploymentChangeRequirements {
  scopes: string[];
  pullsImage: boolean;
}

/** A deploy request: a requested image or tag rolls out other code, as the deployment service treats it. */
export function deploymentDeployRequiredScopes(input: {
  image?: unknown;
  tag?: unknown;
  env?: unknown;
}): DeploymentChangeRequirements {
  const pullsImage = input.image !== undefined || input.tag !== undefined;
  if (pullsImage) return { scopes: [...DEPLOYMENT_EXECUTION_SCOPES], pullsImage };
  return { scopes: input.env !== undefined ? ['docker:containers:environment'] : [], pullsImage };
}

/**
 * An update of the saved configuration. The settings page sends the execution fields with every save, so only a
 * value that differs from the saved one counts as a change.
 */
export function deploymentUpdateRequiredScopes(next: object | undefined, saved: object): DeploymentChangeRequirements {
  const nextValues = (next ?? {}) as Record<string, unknown>;
  const savedValues = saved as Record<string, unknown>;
  const changed = (key: string) =>
    nextValues[key] !== undefined && !sameDesiredValue(key, nextValues[key], savedValues[key]);
  const pullsImage = changed('image');
  if (DEPLOYMENT_EXECUTION_FIELDS.some(changed)) return { scopes: [...DEPLOYMENT_EXECUTION_SCOPES], pullsImage };
  return { scopes: changed('env') ? ['docker:containers:environment'] : [], pullsImage };
}

function sameDesiredValue(key: string, next: unknown, saved: unknown): boolean {
  const normalize = (value: unknown): unknown => {
    if (value === undefined || value === null || value === '') return null;
    if (key === 'runtimeProfile' && value === 'default') return null;
    if (Array.isArray(value)) return value.length > 0 ? value : null;
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return entries.length > 0 ? entries : null;
    }
    return value;
  };
  return JSON.stringify(normalize(next)) === JSON.stringify(normalize(saved));
}
