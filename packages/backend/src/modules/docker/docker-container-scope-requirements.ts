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
    required.push('docker:containers:config', 'docker:containers:environment', 'docker:containers:secrets');
  }
  return required;
}

export function containerUpdateRequiredScopes(config: { env?: unknown; removeEnv?: unknown }): string[] {
  return config.env !== undefined || config.removeEnv !== undefined ? ['docker:containers:environment'] : [];
}
