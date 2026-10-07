import { gitGrantsCover, principalGitConnectorGrants } from '@/lib/git-scopes.js';
import { LookupBudget, LookupBudgetExceededError, TtlCache } from '@/lib/ttl-cache.js';
import type { User } from '@/types.js';
import {
  type GitHubScopeTargets,
  matchesScopeTargetSearch,
  type ParsedScopeTargetId,
  parseScopeTargetIds,
  SCOPE_TARGET_LOOKUP_BUDGET,
  SCOPE_TARGET_LOOKUP_TTL_MS,
  SCOPE_TARGET_SEARCH_MAX_PAGES,
  SCOPE_TARGET_SEARCH_TTL_MS,
  type ScopeTargetLookup,
  type ScopeTargetResolution,
  type ScopeTargetResolutionItem,
  type ScopeTargetSearchQuery,
  scopeTargetPathNotFound,
  scopeTargetTruncation,
  unresolvedScopeTarget,
} from './git-scope-targets.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import { type ConnectorRow, isPlainRecord } from './integrations.service.core.js';
import { IntegrationsSourceService } from './integrations.service.sources.js';

interface GitHubScopeCatalogEntry {
  /** Empty for an organization listed without a repository. */
  id: string;
  fullName: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: string;
}

/** What the connector credential sees; `complete` is false when the page bound cut the repository listing. */
interface GitHubScopeCatalog {
  entries: GitHubScopeCatalogEntry[];
  complete: boolean;
}

/** Repositories and organizations a GitHub connector credential sees, per connector (scope picker search). */
const githubScopeCatalogs = new TtlCache<GitHubScopeCatalog>(SCOPE_TARGET_SEARCH_TTL_MS, 200);
/** Search API results for searches the catalog bound may have cut, per connector and search text. */
const githubScopeSearches = new TtlCache<GitHubScopeCatalog>(SCOPE_TARGET_SEARCH_TTL_MS, 500);
/** Owner logins and repository names by connector and ID (scope picker labels). */
const githubScopeLabels = new TtlCache<{ label: string; ownerId: string | null } | null>(
  SCOPE_TARGET_LOOKUP_TTL_MS,
  5000
);
/** Pages of 100 repositories the catalog reads (the scope picker page bound, doubled for repositories). */
const GITHUB_SCOPE_CATALOG_PAGES = SCOPE_TARGET_SEARCH_MAX_PAGES * 2;
/** Owners one search API query is limited to (GitHub caps query length); more owners leave it inexact. */
const GITHUB_SEARCH_OWNER_LIMIT = 20;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/** Test hook: forget cached GitHub scope picker data. */
export function clearGitHubScopeTargetCache(): void {
  githubScopeCatalogs.clear();
  githubScopeSearches.clear();
  githubScopeLabels.clear();
}

/** Forget a connector's cached picker catalog, searches and labels (on sync). */
export function invalidateGitHubScopeTargets(connectorId: string): void {
  githubScopeCatalogs.delete(connectorId);
  githubScopeSearches.deletePrefix(`${connectorId}:`);
  githubScopeLabels.deletePrefix(`${connectorId}:`);
}

function catalogEntry(row: unknown): GitHubScopeCatalogEntry | null {
  const repository = isPlainRecord(row) ? row : {};
  const owner = isPlainRecord(repository.owner) ? repository.owner : {};
  if (typeof repository.id !== 'number' || typeof owner.id !== 'number') return null;
  return {
    id: String(repository.id),
    fullName: typeof repository.full_name === 'string' ? repository.full_name : String(repository.id),
    ownerId: String(owner.id),
    ownerLogin: typeof owner.login === 'string' ? owner.login : String(owner.id),
    ownerType: typeof owner.type === 'string' ? owner.type : 'User',
  };
}

/**
 * The GitHub Git scope picker: owners and repositories a scope can be limited to, labels for stored qualifiers,
 * and resolving an owner login or `owner/name` to the stable qualifier. The picker reads the credential's
 * repositories up to a page bound and, for a search past that bound, GitHub's search API and the exact
 * repository; results only name what the caller may view and what the connector includes.
 */
export abstract class IntegrationsGitHubScopeTargetService extends IntegrationsSourceService {
  /**
   * Scope picker search for a GitHub connector: owners and repositories the connector credential sees,
   * limited to what the caller may view (connector-wide, a granted owner, or a granted repository).
   * `truncated` says how many matches the limit left out, and whether GitHub had more than was read.
   */
  async listGitHubScopeTargets(
    user: User,
    connectorId: string,
    query: ScopeTargetSearchQuery
  ): Promise<GitHubScopeTargets> {
    const { connector, token, grants } = await this.githubScopeTargetAccess(user, connectorId);
    const catalog = await githubScopeCatalogs.getOrLoad(connector.id, () =>
      this.loadGitHubScopeCatalog(connector, token)
    );
    const search = query.search.trim();
    const searched = search
      ? await githubScopeSearches.getOrLoad(`${connector.id}:${search.toLowerCase()}`, () =>
          this.searchGitHubScopeCatalog(connector, token, catalog, search)
        )
      : { entries: [], complete: catalog.complete };
    const { repositoryIncluded, ownerIncluded } = await this.githubScopeInclusion(connector);
    const owners = new Map<string, GitHubScopeTargets['owners'][number]>();
    const repos = new Map<string, GitHubScopeTargets['repos'][number]>();
    for (const entry of [...catalog.entries, ...searched.entries]) {
      const ownerVisible = grants.every((grant) => grant.connectorWide || grant.containerIds.has(entry.ownerId));
      if (
        ownerVisible &&
        !owners.has(entry.ownerId) &&
        ownerIncluded(entry.ownerLogin) &&
        matchesScopeTargetSearch(query.search, entry.ownerLogin)
      ) {
        owners.set(entry.ownerId, { id: entry.ownerId, login: entry.ownerLogin, type: entry.ownerType });
      }
      if (
        entry.id &&
        !repos.has(entry.id) &&
        repositoryIncluded(entry.fullName) &&
        gitGrantsCover(grants, { repositoryId: entry.id, containerIds: [entry.ownerId] }) &&
        matchesScopeTargetSearch(query.search, entry.fullName)
      ) {
        repos.set(entry.id, { id: entry.id, fullName: entry.fullName });
      }
    }
    const more = Math.max(owners.size - query.limit, 0) + Math.max(repos.size - query.limit, 0);
    return {
      owners: [...owners.values()].slice(0, query.limit),
      repos: [...repos.values()].slice(0, query.limit),
      ...scopeTargetTruncation(more, search ? searched.complete : catalog.complete),
    };
  }

  /** Labels for stored GitHub qualifiers (`owner/<id>`, `repo/<id>`); targets the caller may not view stay unlabeled. */
  async resolveGitHubScopeTargets(user: User, connectorId: string, rawIds: string): Promise<ScopeTargetResolution> {
    const ids = parseScopeTargetIds('github', rawIds);
    const { connector, token, grants } = await this.githubScopeTargetAccess(user, connectorId);
    // Uncached provider lookups per request are capped; targets past the cap stay unlabeled.
    const budget = new LookupBudget(SCOPE_TARGET_LOOKUP_BUDGET);
    const resolveOne = async ({ qualifier, kind, id }: ParsedScopeTargetId): Promise<ScopeTargetResolutionItem> => {
      if (kind === 'owner') {
        if (!grants.every((grant) => grant.connectorWide || grant.containerIds.has(id))) {
          return unresolvedScopeTarget(qualifier);
        }
        const owner = await githubScopeLabels.load(
          `${connector.id}:owner:${id}`,
          () =>
            this.githubScopeLabel(connector, token, `/user/${id}`, (body) =>
              typeof body.login === 'string' ? { label: body.login, ownerId: id } : null
            ),
          { budget }
        );
        return owner
          ? { qualifier, label: owner.label, missing: false }
          : { qualifier, label: qualifier, missing: true };
      }
      // Without an owner grant, only the exact repository (or the connector) can make it visible: no lookup needed.
      const couldSee = grants.every(
        (grant) => grant.connectorWide || grant.repositoryIds.has(id) || grant.containerIds.size > 0
      );
      if (!couldSee) return unresolvedScopeTarget(qualifier);
      const repository = await githubScopeLabels.load(
        `${connector.id}:repo:${id}`,
        () =>
          this.githubScopeLabel(connector, token, `/repositories/${id}`, (body) => {
            const owner = isPlainRecord(body.owner) ? body.owner : {};
            return typeof body.full_name === 'string'
              ? { label: body.full_name, ownerId: typeof owner.id === 'number' ? String(owner.id) : null }
              : null;
          }),
        { budget }
      );
      const target = { repositoryId: id, containerIds: repository?.ownerId ? [repository.ownerId] : [] };
      if (!gitGrantsCover(grants, target)) return unresolvedScopeTarget(qualifier);
      return repository
        ? { qualifier, label: repository.label, missing: false }
        : { qualifier, label: qualifier, missing: true };
    };
    const items = await Promise.all(
      ids.map((target) =>
        resolveOne(target).catch((error: unknown) => {
          if (error instanceof LookupBudgetExceededError) return unresolvedScopeTarget(target.qualifier);
          throw error;
        })
      )
    );
    return { items };
  }

  /**
   * The stable qualifier of a GitHub owner (login) or repository (`owner/name`), for API and MCP callers that
   * know names. Only the ID is ever stored; a name the caller may not view, or that the connector does not
   * include, answers exactly like one that does not exist.
   */
  async lookupGitHubScopeTargetPath(
    user: User,
    connectorId: string,
    kind: 'owner' | 'repo',
    path: string
  ): Promise<ScopeTargetLookup> {
    const { connector, token, grants } = await this.githubScopeTargetAccess(user, connectorId);
    const segments = path.split('/');
    const { repositoryIncluded, ownerIncluded } = await this.githubScopeInclusion(connector);
    if (kind === 'owner') {
      if (segments.length !== 1 || !GITHUB_NAME.test(path)) throw scopeTargetPathNotFound(path);
      const owner = await this.githubScopeLabel(connector, token, `/users/${encodeURIComponent(path)}`, (body) =>
        typeof body.id === 'number' && typeof body.login === 'string'
          ? { label: body.login, ownerId: String(body.id) }
          : null
      );
      if (!owner?.ownerId || !ownerIncluded(owner.label)) throw scopeTargetPathNotFound(path);
      const ownerId = owner.ownerId;
      if (!grants.every((grant) => grant.connectorWide || grant.containerIds.has(ownerId))) {
        throw scopeTargetPathNotFound(path);
      }
      return { qualifier: `owner/${ownerId}`, kind, id: ownerId, path: owner.label };
    }
    if (segments.length !== 2 || !segments.every((segment) => GITHUB_NAME.test(segment))) {
      throw scopeTargetPathNotFound(path);
    }
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/repos/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(segments[1]!)}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status === 404) throw scopeTargetPathNotFound(path);
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const entry = catalogEntry(body);
    if (
      !entry ||
      !repositoryIncluded(entry.fullName) ||
      !gitGrantsCover(grants, { repositoryId: entry.id, containerIds: [entry.ownerId] })
    ) {
      throw scopeTargetPathNotFound(path);
    }
    return { qualifier: `repo/${entry.id}`, kind, id: entry.id, path: entry.fullName };
  }

  private async githubScopeTargetAccess(user: User, connectorId: string) {
    const connector = await this.getConnectorRow(connectorId, 'github');
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes, accountScopes: user.accountScopes },
      provider: 'github',
      connectorId: connector.id,
      connectorName: connector.name,
      operation: 'connector.scope_targets',
      requiredScope: 'integrations:github:view',
      scopeTarget: 'within-connector',
    });
    const grants = principalGitConnectorGrants(user, 'integrations:github:view', connector.id);
    return { connector, grants, token: await this.connectorGitHubToken(connector) };
  }

  /**
   * What the connector includes: every visible repository, or only its allowlist. An owner is included when an
   * included repository belongs to it.
   */
  private async githubScopeInclusion(connector: ConnectorRow) {
    if (connector.allowlistMode === 'all_visible') {
      return { repositoryIncluded: (_fullName: string) => true, ownerIncluded: (_login: string) => true };
    }
    const base = connector.baseUrl.replace(/\/+$/, '').toLowerCase();
    const allowed = new Set(
      (await this.listAllowlistRows(connector.id))
        .filter((entry) => entry.entryType === 'project')
        .flatMap((entry) => {
          try {
            return [this.normalizeRepositoryUrl(entry.fullPath).toLowerCase()];
          } catch {
            return [];
          }
        })
    );
    return {
      repositoryIncluded: (fullName: string) => allowed.has(`${base}/${fullName.toLowerCase()}`),
      ownerIncluded: (login: string) => {
        const prefix = `${base}/${login.toLowerCase()}/`;
        return [...allowed].some((url) => url.startsWith(prefix));
      },
    };
  }

  /** The credential's repositories (up to the page bound) and the organizations it belongs to. */
  private async loadGitHubScopeCatalog(connector: ConnectorRow, token: string): Promise<GitHubScopeCatalog> {
    const entries: GitHubScopeCatalogEntry[] = [];
    let complete = false;
    for (let page = 1; page <= GITHUB_SCOPE_CATALOG_PAGES; page += 1) {
      const response = await this.githubConnectorRequest(
        connector,
        token,
        `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member`
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
      const rows = Array.isArray(body) ? body : [];
      for (const row of rows) {
        const entry = catalogEntry(row);
        if (entry) entries.push(entry);
      }
      if (rows.length < 100) {
        complete = true;
        break;
      }
    }
    // Organizations the credential belongs to, even without a repository it can see.
    const organizations = await this.githubConnectorRequest(connector, token, '/user/orgs?per_page=100');
    const organizationBody = (await organizations.json().catch(() => null)) as unknown;
    if (organizations.ok && Array.isArray(organizationBody)) {
      for (const row of organizationBody) {
        const organization = isPlainRecord(row) ? row : {};
        if (typeof organization.id !== 'number' || typeof organization.login !== 'string') continue;
        entries.push({
          id: '',
          fullName: '',
          ownerId: String(organization.id),
          ownerLogin: organization.login,
          ownerType: 'Organization',
        });
      }
    }
    return { entries, complete };
  }

  /**
   * Repositories a search may need beyond the catalog: the exact `owner/name` repository, and, when the page
   * bound cut the catalog, GitHub's search API limited to the catalog's owners. A failed search (for example
   * GitHub's search rate limit) leaves the result marked incomplete instead of failing the picker.
   */
  private async searchGitHubScopeCatalog(
    connector: ConnectorRow,
    token: string,
    catalog: GitHubScopeCatalog,
    search: string
  ): Promise<GitHubScopeCatalog> {
    const entries: GitHubScopeCatalogEntry[] = [];
    let complete = catalog.complete;
    const segments = search.split('/');
    if (segments.length === 2 && segments.every((segment) => GITHUB_NAME.test(segment))) {
      const exact = await this.githubConnectorRequest(
        connector,
        token,
        `/repos/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(segments[1]!)}`
      );
      const entry = exact.ok ? catalogEntry(await exact.json().catch(() => null)) : null;
      if (entry) entries.push(entry);
    }
    if (catalog.complete) return { entries, complete };
    const owners = new Map<string, string>();
    for (const entry of catalog.entries) owners.set(entry.ownerLogin, entry.ownerType);
    const term = segments.filter(Boolean).pop() ?? '';
    if (!GITHUB_NAME.test(term)) return { entries, complete: false };
    const qualifiers = [...owners]
      .slice(0, GITHUB_SEARCH_OWNER_LIMIT)
      .map(([login, type]) => `${type === 'Organization' ? 'org' : 'user'}:${login}`);
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/search/repositories?per_page=100&q=${encodeURIComponent([`${term} in:name fork:true`, ...qualifiers].join(' '))}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isPlainRecord(body) || !Array.isArray(body.items)) return { entries, complete: false };
    for (const item of body.items) {
      const entry = catalogEntry(item);
      if (entry) entries.push(entry);
    }
    complete =
      owners.size <= GITHUB_SEARCH_OWNER_LIMIT &&
      body.incomplete_results !== true &&
      typeof body.total_count === 'number' &&
      body.total_count <= body.items.length;
    return { entries, complete };
  }

  private async githubScopeLabel(
    connector: ConnectorRow,
    token: string,
    path: string,
    read: (body: Record<string, unknown>) => { label: string; ownerId: string | null } | null
  ): Promise<{ label: string; ownerId: string | null } | null> {
    const response = await this.githubConnectorRequest(connector, token, path);
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status === 404) return null;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    return isPlainRecord(body) ? read(body) : null;
  }
}
