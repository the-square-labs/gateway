import type { dockerMigrations } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';

export type MigrationRow = typeof dockerMigrations.$inferSelect;

export interface StoredMigrationPlan extends Record<string, unknown> {
  manifest?: Record<string, any>;
  deployment?: Record<string, any>;
  deploymentManifests?: Record<string, Record<string, any>>;
  encryptedExecutionPlan?: { encryptedKey: string; encryptedDek: string };
  deploymentActiveSlot?: string;
  target?: Record<string, string>;
  targetNodeSlug?: string;
  plannedChanges?: string[];
  verificationPlan?: string[];
  environmentKeyCount?: number;
  secretKeyCount?: number;
}

export function migrationPlan(row: MigrationRow): StoredMigrationPlan {
  return (row.plan ?? {}) as StoredMigrationPlan;
}

export function sealMigrationPlan(plan: StoredMigrationPlan, crypto: CryptoService): StoredMigrationPlan {
  const {
    manifest,
    deployment,
    deploymentManifests,
    encryptedExecutionPlan: _previousEncryptedPlan,
    ...safePlan
  } = plan;
  const executionPlan = {
    ...(manifest ? { manifest } : {}),
    ...(deployment ? { deployment } : {}),
    ...(deploymentManifests ? { deploymentManifests } : {}),
  };
  if (Object.keys(executionPlan).length === 0) return safePlan;
  return {
    ...safePlan,
    encryptedExecutionPlan: crypto.encryptString(JSON.stringify(executionPlan)),
  };
}

export function openMigrationPlan(row: MigrationRow, crypto: CryptoService): StoredMigrationPlan {
  const stored = migrationPlan(row);
  if (!stored.encryptedExecutionPlan) return stored;
  try {
    const decrypted = JSON.parse(crypto.decryptString(stored.encryptedExecutionPlan)) as {
      manifest?: Record<string, any>;
      deployment?: Record<string, any>;
      deploymentManifests?: Record<string, Record<string, any>>;
    };
    return {
      ...stored,
      manifest: decrypted.manifest,
      deployment: decrypted.deployment,
      deploymentManifests: decrypted.deploymentManifests,
    };
  } catch {
    throw new AppError(500, 'MIGRATION_PLAN_DECRYPT_FAILED', 'Docker migration execution plan could not be decrypted');
  }
}

export function migrationDeploymentContainerNames(payload: Record<string, any>): string[] {
  return [payload.routerName, ...Object.values(payload.slots ?? {})].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

export function migrationDeploymentSnapshot(deployment: any): Record<string, any> {
  const desiredConfig = { ...deployment.desiredConfig, env: undefined };
  return {
    deploymentId: deployment.id,
    name: deployment.name,
    activeSlot: deployment.activeSlot,
    routerName: deployment.routerName,
    routerImage: deployment.routerImage,
    networkName: deployment.networkName,
    slots: Object.fromEntries(deployment.slots.map((slot: any) => [slot.slot, slot.containerName])),
    slotConfigs: Object.fromEntries(
      deployment.slots.map((slot: any) => [
        slot.slot,
        { ...(slot.desiredConfig ?? deployment.desiredConfig), env: undefined },
      ])
    ),
    routes: deployment.routes,
    health: deployment.healthConfig,
    desiredConfig,
    deployment: {
      id: deployment.id,
      routerName: deployment.routerName,
      routerImage: deployment.routerImage,
      networkName: deployment.networkName,
      activeSlot: deployment.activeSlot,
      routes: deployment.routes,
      healthConfig: deployment.healthConfig,
      desiredConfig,
      slots: deployment.slots.map((slot: any) => ({ slot: slot.slot, containerName: slot.containerName })),
    },
  };
}

export function migrationEnvList(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

export function migrationEnvMap(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) return {};
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const index = entry.indexOf('=');
    result[index < 0 ? entry : entry.slice(0, index)] = index < 0 ? '' : entry.slice(index + 1);
  }
  return result;
}

export function equalMigrationEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

export function assertMigrationDeletionGate(row: MigrationRow, artifacts: Array<{ state: string }>): void {
  const verification = row.verification as Record<string, unknown>;
  const required = [
    'imageDigestVerified',
    'volumeTreeVerified',
    'fsyncVerified',
    'manifestVerified',
    'environmentVerified',
    'secretsVerified',
  ];
  if (['running', 'ready'].includes(row.sourceState)) required.push('healthVerified');
  if (required.some((key) => verification[key] !== true) || artifacts.some((item) => item.state !== 'verified')) {
    throw new AppError(
      409,
      'MIGRATION_DELETION_GATE_FAILED',
      'Source deletion is blocked until every target verification gate passes'
    );
  }
}

export function assertMigrationManifest(source: Record<string, any>, target: Record<string, any>): void {
  const normalizeHostConfig = (hostConfig: Record<string, any> | undefined) => ({
    ...hostConfig,
    OomKillDisable: hostConfig?.OomKillDisable ?? false,
  });
  const normalizeEndpoint = (endpoint: Record<string, any> | null | undefined) => {
    if (!endpoint) return {};
    return Object.fromEntries(
      Object.entries(endpoint).filter(([, value]) => {
        if (value === null || value === undefined || value === '') return false;
        if (Array.isArray(value) && value.length === 0) return false;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
        if (typeof value === 'number' && value === 0) return false;
        return true;
      })
    );
  };
  const normalizeNetworkingConfig = (networkingConfig: Record<string, any> | null | undefined) => {
    const endpoints = networkingConfig?.EndpointsConfig ?? {};
    const normalizedEndpoints = Object.fromEntries(
      Object.entries(endpoints).flatMap(([network, endpoint]) => {
        const normalizedEndpoint = normalizeEndpoint(endpoint as Record<string, any> | null | undefined);
        // Docker 29.x patch releases differ in whether the implicit default bridge
        // is represented as an omitted endpoint or an empty endpoint object.
        if (network === 'bridge' && Object.keys(normalizedEndpoint).length === 0) return [];
        return [[network, normalizedEndpoint]];
      })
    );
    return { ...(networkingConfig ?? {}), EndpointsConfig: normalizedEndpoints };
  };
  const normalizeConfig = (manifest: Record<string, any>) => ({
    ...(manifest.config ?? {}),
    // The target is created from the imported, separately verified image ID.
    // ImageReference still preserves the configured repository reference.
    Image: manifest.imageId ?? manifest.config?.Image,
  });
  const normalize = (manifest: Record<string, any>) => ({
    imageId: manifest.imageId,
    imageReference: manifest.imageReference,
    config: normalizeConfig(manifest),
    hostConfig: normalizeHostConfig(manifest.hostConfig),
    networkingConfig: normalizeNetworkingConfig(manifest.networkingConfig),
    envKeys: manifest.envKeys,
    volumeNames: manifest.volumeNames,
  });
  const difference = firstManifestDifference(normalize(source), normalize(target), 'manifest');
  if (difference) {
    throw new AppError(
      502,
      'MIGRATION_MANIFEST_MISMATCH',
      `Target Docker create configuration differs at ${difference}`
    );
  }
}

function firstManifestDifference(left: unknown, right: unknown, path: string): string | null {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return path;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstManifestDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return path;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) return `${path}.${key}`;
    const difference = firstManifestDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

export async function waitForMigratedContainer(
  inspect: () => Promise<Record<string, any>>,
  running: boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const state = (await inspect()).State as Record<string, any> | undefined;
    if (!running && state?.Status !== 'running') return;
    if (running && state?.Running) {
      const health = state.Health?.Status;
      if (health === 'unhealthy') throw new AppError(502, 'MIGRATION_HEALTH_FAILED', 'Target container is unhealthy');
      if (health === 'healthy') return;
      if (!health) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 10_000) return;
      }
    } else stableSince = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new AppError(504, 'MIGRATION_HEALTH_TIMEOUT', 'Target container did not reach the required state');
}
