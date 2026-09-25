import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { integrationConnectors } from '@/db/schema/index.js';
import { hasScopeBase } from '@/lib/permissions.js';

/** Git providers a container, deployment, Compose Project or Pages build can be built from. */
export const SOURCE_CONNECTOR_PROVIDERS = ['gitlab', 'github', 'git'] as const;
export type SourceConnectorProvider = (typeof SOURCE_CONNECTOR_PROVIDERS)[number];

/**
 * Picking a Git source is part of creating or editing the workload that builds from it, so it is authorized by that
 * workload's scopes, not by the integration's own scopes (those administer the connector). Any node, folder or
 * resource variant counts: the action that saves the source checks the exact target.
 */
export const DOCKER_SOURCE_PICKER_SCOPES = [
  'docker:containers:create',
  'docker:containers:edit',
  'docker:compose:create',
  'docker:compose:manage',
] as const;
export const SOURCE_CONNECTOR_PICKER_SCOPES = [...DOCKER_SOURCE_PICKER_SCOPES, 'pages:create', 'pages:edit'] as const;

export function canPickDockerSource(scopes: string[]): boolean {
  return DOCKER_SOURCE_PICKER_SCOPES.some((scope) => hasScopeBase(scopes, scope));
}

export function canListSourceConnectors(scopes: string[]): boolean {
  return SOURCE_CONNECTOR_PICKER_SCOPES.some((scope) => hasScopeBase(scopes, scope));
}

export interface SourceConnectorOption {
  id: string;
  name: string;
  provider: SourceConnectorProvider;
}

/** Enabled Git connectors as picker options: identity only, no URL, credential or allowlist data. */
export async function listSourceConnectors(db: DrizzleClient): Promise<SourceConnectorOption[]> {
  const rows = await db
    .select({
      id: integrationConnectors.id,
      name: integrationConnectors.name,
      provider: integrationConnectors.provider,
    })
    .from(integrationConnectors)
    .where(
      and(
        inArray(integrationConnectors.provider, [...SOURCE_CONNECTOR_PROVIDERS]),
        eq(integrationConnectors.enabled, true)
      )
    )
    .orderBy(asc(integrationConnectors.name));
  return rows.map((row) => ({ id: row.id, name: row.name, provider: row.provider as SourceConnectorProvider }));
}
