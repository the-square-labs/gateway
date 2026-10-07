const RECREATE_EXECUTION_FIELDS = ['image', 'entrypoint', 'command', 'user', 'runtimeProfile'] as const;

/**
 * Scopes a recreate request needs beyond docker:containers:manage. A plain
 * recreate stays on manage; changing what the container executes can expose
 * its environment and secrets, so it needs the same scopes as duplicate. The
 * container's own scopes authorize pulling a new image, as creation does.
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
 * An env-only change of a container, on every route that makes one (PUT .../env, an update with env alone, the AI
 * tools). The recreate that applies the values is part of the change, so environment is all it needs.
 */
export const CONTAINER_ENV_CHANGE_SCOPES = ['docker:containers:environment'] as const;

/**
 * Scopes a container update (pull + redeploy) needs on the container. A new tag runs other code with the container's
 * env and secrets, like a recreate with a new image; the container's own edit authorizes pulling it, as creating the
 * container authorizes its first pull. An env-only update is an env change; a plain redeploy stays on edit.
 */
export function containerUpdateRequiredScopes(config: { tag?: unknown; env?: unknown; removeEnv?: unknown }): string[] {
  if (containerUpdateChangesImage(config)) {
    return ['docker:containers:edit', 'docker:containers:environment', 'docker:containers:secrets'];
  }
  if (config.env !== undefined || config.removeEnv !== undefined) return [...CONTAINER_ENV_CHANGE_SCOPES];
  return ['docker:containers:edit'];
}

const DEPLOYMENT_EXECUTION_FIELDS = ['image', 'command', 'entrypoint', 'user', 'runtimeProfile'] as const;
const DEPLOYMENT_EXECUTION_SCOPES = [
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:secrets',
] as const;

/**
 * What a deploy request needs on the deployment beyond docker:containers:manage. Every rollout starts the new slot
 * with the deployment's env and secrets, so a requested image or tag (other code, as the deployment service treats it)
 * needs the scopes of a container recreate with a new image; the deployment's own scopes authorize pulling it.
 * Replacing the env needs environment.
 */
export function deploymentDeployRequiredScopes(input: { image?: unknown; tag?: unknown; env?: unknown }): string[] {
  if (input.image !== undefined || input.tag !== undefined) return [...DEPLOYMENT_EXECUTION_SCOPES];
  return input.env !== undefined ? ['docker:containers:environment'] : [];
}

/**
 * What an update of the saved configuration needs on the deployment. The settings page sends the execution fields
 * with every save, so only a value that differs from the saved one counts as a change. Saving the environment alone
 * needs environment, as a container env change does (the slots get it with the next rollout, which needs manage);
 * any other change needs edit, and changing what the slots execute also needs environment and secrets.
 */
export function deploymentUpdateRequiredScopes(
  input: { name?: unknown; desiredConfig?: object; routes?: unknown; health?: unknown; drainSeconds?: unknown },
  saved: { desiredConfig: object }
): string[] {
  const nextValues = (input.desiredConfig ?? {}) as Record<string, unknown>;
  const savedValues = saved.desiredConfig as Record<string, unknown>;
  const changed = (key: string) =>
    nextValues[key] !== undefined && !sameDesiredValue(key, nextValues[key], savedValues[key]);
  if (DEPLOYMENT_EXECUTION_FIELDS.some(changed)) return [...DEPLOYMENT_EXECUTION_SCOPES];
  if (!changed('env')) return ['docker:containers:edit'];
  const envOnly =
    input.name === undefined &&
    input.routes === undefined &&
    input.health === undefined &&
    input.drainSeconds === undefined &&
    Object.keys(nextValues).every((key) => key === 'env' || !changed(key));
  return envOnly ? ['docker:containers:environment'] : ['docker:containers:edit', 'docker:containers:environment'];
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
