import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { integrationConnectors } from '@/db/schema/index.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { gitConnectorVisibility } from '@/modules/integrations/integration-permissions.js';

/** Git providers a container, deployment, Compose Project or Pages build can be built from. */
export const SOURCE_CONNECTOR_PROVIDERS = ['gitlab', 'github', 'git'] as const;
export type SourceConnectorProvider = (typeof SOURCE_CONNECTOR_PROVIDERS)[number];

/**
 * Picking a Git source is part of creating or editing the workload that builds from it, so the picker is authorized by
 * that workload's scopes. Any node, folder or resource variant counts: the action that saves the source checks the
 * exact target. The connectors and repositories it offers are the ones the caller may see through its Git scopes, and
 * saving a source needs integrations:<provider>:use on the repository (IntegrationsService.assertBuildSourceRepositoryAccess).
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

/**
 * Enabled Git connectors as picker options: identity only, no URL, credential or allowlist data. Only connectors the
 * caller holds a Git scope on (any qualifier; `use` implies `view`) are listed.
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
  const visibility = Object.fromEntries(
    SOURCE_CONNECTOR_PROVIDERS.map((provider) => [provider, gitConnectorVisibility(scopes, provider)])
  ) as Record<SourceConnectorProvider, ReturnType<typeof gitConnectorVisibility>>;
  return rows
    .filter((row) => visibility[row.provider as SourceConnectorProvider]?.(row.id).visible)
    .map((row) => ({ id: row.id, name: row.name, provider: row.provider as SourceConnectorProvider }));
}
