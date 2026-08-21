export type E2EConfig = {
  apiUrl: string;
  databaseUrl: string;
  allowMutations: boolean;
  allowRuntimeMutations: boolean;
  allowUnhealthy: boolean;
  keepToken: boolean;
  dockerImage?: string;
  profile: 'full' | 'release-upgrade';
};

export function loadConfig(): E2EConfig {
  return {
    apiUrl: process.env.GATEWAY_E2E_API_URL ?? 'http://localhost:3000',
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/gateway',
    allowMutations: process.env.GATEWAY_E2E_ALLOW_MUTATIONS === '1',
    allowRuntimeMutations: process.env.GATEWAY_E2E_ALLOW_RUNTIME_MUTATIONS === '1',
    allowUnhealthy: process.env.GATEWAY_E2E_ALLOW_UNHEALTHY === '1',
    keepToken: process.env.GATEWAY_E2E_KEEP_TOKEN === '1',
    dockerImage: process.env.GATEWAY_E2E_DOCKER_IMAGE,
    profile: process.env.GATEWAY_E2E_PROFILE === 'release-upgrade' ? 'release-upgrade' : 'full',
  };
}

export function e2eName(suffix: string) {
  return `codex-e2e-${Date.now()}-${suffix}`;
}
