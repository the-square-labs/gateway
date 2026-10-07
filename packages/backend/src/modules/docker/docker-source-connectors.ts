import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { integrationConnectors } from '@/db/schema/index.js';
import { gitGrantedConnectorIds } from '@/lib/git-scopes.js';
import { hasScopeBase } from '@/lib/permissions.js';

/** Git providers a container, deployment, Compose Project or Pages build can be built from. */
export const SOURCE_CONNECTOR_PROVIDERS = ['gitlab', 'github', 'git'] as const;
export type SourceConnectorProvider = (typeof SOURCE_CONNECTOR_PROVIDERS)[number];

/**
 * Picking a Git source is part of creating or editing the workload that builds from it, so the picker is authorized by
 * that workload's scopes. Any node, folder or resource variant counts: the action that saves the source checks the
 * exact target. Connecting a source or changing its connector, repository or branch needs
 * integrations:<provider>:use on the repository (IntegrationsService.assertBuildSourceRepositoryAccess), so the
 * connectors and repositories it offers are the ones the caller's `use` grants cover. Builds and other source
 * settings need only the workload's own permissions.
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

/** The repository picker's optional `search` query: trimmed, at most 200 characters, undefined when empty. */
export function sourceRepositorySearch(value: string | undefined): string | undefined {
  const search = value?.trim().slice(0, 200);
  return search || undefined;
}

export interface SourceConnectorOption {
  id: string;
  name: string;
  provider: SourceConnectorProvider;
}

/**
 * Enabled Git connectors as picker options: identity only, no URL, credential or allowlist data. Only connectors the
 * caller holds integrations:<provider>:use on (any qualifier: the connector, a group or owner, or a repository) are
 * listed, since saving a source needs it.
 */
export async function listSourceConnectors(
  db: DrizzleClient,
  scopes: readonly string[]
): Promise<SourceConnectorOption[]> {
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
  const usable = Object.fromEntries(
    SOURCE_CONNECTOR_PROVIDERS.map((provider) => [
      provider,
      gitGrantedConnectorIds(scopes, `integrations:${provider}:use`),
    ])
  ) as Record<SourceConnectorProvider, ReturnType<typeof gitGrantedConnectorIds>>;
  return rows
    .filter((row) => {
      const granted = usable[row.provider as SourceConnectorProvider];
      return !!granted && (granted.all || granted.connectorIds.has(row.id));
    })
    .map((row) => ({ id: row.id, name: row.name, provider: row.provider as SourceConnectorProvider }));
}
