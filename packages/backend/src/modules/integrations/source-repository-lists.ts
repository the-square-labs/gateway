import { type GitConnectorGrant, gitGrantsConnectorWide } from '@/lib/git-scopes.js';
import { StaleWhileRevalidateCache } from '@/lib/stale-while-revalidate-cache.js';
import type { ScopeTargetTruncation } from './git-scope-targets.js';
import type { DockerBuildSourceRepository } from './integrations.service.core.js';

export interface SourceRepositoryList {
  repositories: DockerBuildSourceRepository[];
  truncated?: ScopeTargetTruncation;
}

/** A listed picker answers at once for a minute, then from the last list while it reloads, for 15 minutes. */
const SOURCE_REPOSITORY_LIST_FRESH_MS = 60_000;
const SOURCE_REPOSITORY_LIST_STALE_MS = 15 * 60_000;

/**
 * The build-source picker's repository lists per connector and caller grants. Only the lists that call the
 * provider are kept: GitHub (the credential's repositories, page by page) and GitLab for a caller limited to
 * groups (each project's group ancestry). Saving a source checks the repository again, so a stale list only
 * offers what the caller could pick a moment ago.
 */
const sourceRepositoryLists = new StaleWhileRevalidateCache<SourceRepositoryList>(
  SOURCE_REPOSITORY_LIST_FRESH_MS,
  SOURCE_REPOSITORY_LIST_STALE_MS,
  500
);

export function sourceRepositoryListCached(provider: string, grants: GitConnectorGrant[]): boolean {
  return provider === 'github' || (provider === 'gitlab' && !gitGrantsConnectorWide(grants));
}

function grantKey(grant: GitConnectorGrant): string {
  return [
    grant.connectorWide ? '*' : '',
    [...grant.containerIds].sort().join(','),
    [...grant.repositoryIds].sort().join(','),
  ].join('|');
}

/**
 * The last list (reloaded in the background when it is older than a minute; `refreshing` is then set), or, with
 * `awaitRefresh`, the list once a running reload has finished, so a picker can replace what it showed.
 */
export async function cachedSourceRepositoryList(
  connectorId: string,
  userId: string,
  grants: GitConnectorGrant[],
  load: () => Promise<SourceRepositoryList>,
  options: { awaitRefresh?: boolean } = {}
): Promise<SourceRepositoryList & { refreshing?: true }> {
  const key = `${connectorId}:${userId}:${grants.map(grantKey).sort().join(';')}`;
  if (options.awaitRefresh) return sourceRepositoryLists.settled(key, load);
  const { value, refreshing } = await sourceRepositoryLists.get(key, load);
  return refreshing ? { ...value, refreshing: true } : value;
}

/** Forget a connector's cached picker lists (on sync or an allowlist change). */
export function invalidateSourceRepositoryLists(connectorId: string): void {
  sourceRepositoryLists.deletePrefix(`${connectorId}:`);
}

/** Test hook: forget every cached picker list. */
export function clearSourceRepositoryLists(): void {
  sourceRepositoryLists.clear();
}
