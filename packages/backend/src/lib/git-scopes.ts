import { hasScope, hasScopeBase, scopeMatcher } from './permissions.js';
import { extractBaseScope } from './scopes.js';
import {
  GIT_TARGET_KINDS,
  type GitScopeProvider,
  gitScopeProviderOf,
  isGitScopeBase,
  parseGitScopeQualifier,
} from './scopes-git.js';

/**
 * One repository as Git scope checks see it. Every ID is the provider's stable ID.
 * - GitLab: `repositoryId` is the project ID and `containerIds` the project's namespace group and every
 *   parent group (from the GitLab API; a moved project follows its new group).
 * - GitHub: `repositoryId` is the repository ID and `containerIds` holds the owner (organization or user) ID.
 * - Generic Git: the connector only.
 */
export interface GitRepositoryScopeTarget {
  connectorId: string;
  repositoryId?: string | null;
  containerIds?: readonly string[];
}

type ScopeHolder = readonly string[] | ((scope: string) => boolean);

function holderOf(scopes: ScopeHolder): (scope: string) => boolean {
  return typeof scopes === 'function' ? scopes : scopeMatcher(scopes);
}

function requireGitProvider(requiredScope: string): GitScopeProvider {
  const provider = gitScopeProviderOf(requiredScope);
  if (!provider) throw new Error(`${requiredScope} is not a Git integration scope`);
  return provider;
}

/**
 * The qualifiers that grant an operation on a repository, broadest first: the connector, each containing
 * group or owner, then the exact project or repository. The unqualified scope is matched by hasScope.
 */
export function gitRepositoryQualifiers(provider: GitScopeProvider, target: GitRepositoryScopeTarget): string[] {
  const qualifiers = [target.connectorId];
  const kinds = GIT_TARGET_KINDS[provider];
  if (!kinds) return qualifiers;
  for (const id of target.containerIds ?? []) qualifiers.push(`${target.connectorId}/${kinds.container}/${id}`);
  if (target.repositoryId) qualifiers.push(`${target.connectorId}/${kinds.repository}/${target.repositoryId}`);
  return qualifiers;
}

/**
 * Whether scopes allow `requiredScope` (a Git base scope such as `integrations:gitlab:repo:read`) on a
 * repository: the unqualified scope, the connector qualifier, any containing group/owner qualifier, or the
 * exact project/repository qualifier. Implied view applies per qualifier (`repo:write:<q>` grants `view:<q>`).
 */
export function hasGitRepositoryScope(
  scopes: ScopeHolder,
  requiredScope: string,
  target: GitRepositoryScopeTarget
): boolean {
  const holds = holderOf(scopes);
  return gitRepositoryQualifiers(requireGitProvider(requiredScope), target).some((qualifier) =>
    holds(`${requiredScope}:${qualifier}`)
  );
}

/** Connector-level operations (managing the connection): the unqualified scope or the connector qualifier. */
export function hasGitConnectorScope(scopes: ScopeHolder, requiredScope: string, connectorId: string): boolean {
  return holderOf(scopes)(`${requiredScope}:${connectorId}`);
}

/** What a principal holds of one scope on one connector, after implication. */
export interface GitConnectorGrant {
  /** The unqualified scope or the connector qualifier: every repository of the connector. */
  connectorWide: boolean;
  /** GitLab group or GitHub owner IDs. */
  containerIds: Set<string>;
  /** GitLab project or GitHub repository IDs. */
  repositoryIds: Set<string>;
}

/** Summarize the qualifiers through which scopes grant `requiredScope` on one connector. */
export function gitConnectorGrant(
  scopes: readonly string[],
  requiredScope: string,
  connectorId: string
): GitConnectorGrant {
  const provider = requireGitProvider(requiredScope);
  const kinds = GIT_TARGET_KINDS[provider];
  const grant: GitConnectorGrant = {
    connectorWide: hasGitConnectorScope(scopes, requiredScope, connectorId),
    containerIds: new Set(),
    repositoryIds: new Set(),
  };
  if (grant.connectorWide || !kinds) return grant;
  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    if (scope === base || !isGitScopeBase(base)) continue;
    const qualifier = scope.slice(base.length + 1);
    const parsed = parseGitScopeQualifier(qualifier);
    if (!parsed || parsed.connectorId !== connectorId || !parsed.id) continue;
    if (parsed.kind !== kinds.container && parsed.kind !== kinds.repository) continue;
    // The held scope must be the required one or imply it at the same qualifier.
    if (!hasScope([scope], `${requiredScope}:${qualifier}`)) continue;
    (parsed.kind === kinds.container ? grant.containerIds : grant.repositoryIds).add(parsed.id);
  }
  return grant;
}

/** Whether a grant names anything on the connector (listing endpoints filter the results per repository). */
export function hasGitGrant(grant: GitConnectorGrant): boolean {
  return grant.connectorWide || grant.containerIds.size > 0 || grant.repositoryIds.size > 0;
}

/** Whether scopes grant `requiredScope` on the connector or on any group, owner, project or repository in it. */
export function hasGitScopeOnConnector(scopes: readonly string[], requiredScope: string, connectorId: string): boolean {
  return hasGitGrant(gitConnectorGrant(scopes, requiredScope, connectorId));
}

/** Whether a grant covers a repository whose containers (groups or owner) are already known. */
export function gitGrantCovers(
  grant: GitConnectorGrant,
  target: Omit<GitRepositoryScopeTarget, 'connectorId'>
): boolean {
  if (grant.connectorWide) return true;
  if (target.repositoryId && grant.repositoryIds.has(target.repositoryId)) return true;
  return (target.containerIds ?? []).some((id) => grant.containerIds.has(id));
}

/** Connectors on which scopes grant `requiredScope` anywhere; `all` when the unqualified scope is held. */
export function gitGrantedConnectorIds(
  scopes: readonly string[],
  requiredScope: string
): { all: boolean; connectorIds: Set<string> } {
  requireGitProvider(requiredScope);
  if (hasScope(scopes, requiredScope)) return { all: true, connectorIds: new Set() };
  const connectorIds = new Set<string>();
  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    if (scope === base || !isGitScopeBase(base)) continue;
    const qualifier = scope.slice(base.length + 1);
    const parsed = parseGitScopeQualifier(qualifier);
    if (parsed && hasScope([scope], `${requiredScope}:${qualifier}`)) connectorIds.add(parsed.connectorId);
  }
  return { all: false, connectorIds };
}

/** Whether scopes grant `requiredScope` anywhere: unqualified or on any connector, group, owner, project or repository. */
export function hasGitScopeAnywhere(scopes: readonly string[], requiredScope: string): boolean {
  return hasScopeBase([...scopes], requiredScope);
}

/**
 * Whether deciding `requiredScopes` on a repository needs provider data first: some required Git scope is not
 * granted connector-wide, is not granted for the already known repository ID, and narrower grants exist that
 * could still cover it (GitLab group ancestry, or a GitHub repository whose IDs are not known yet).
 */
export function gitGrantNeedsLookup(
  scopes: readonly string[],
  requiredScopes: readonly string[],
  connectorId: string,
  known: { repositoryId?: string | null } = {}
): boolean {
  return requiredScopes.some((requiredScope) => {
    if (!isGitScopeBase(requiredScope)) return false;
    const grant = gitConnectorGrant(scopes, requiredScope, connectorId);
    if (grant.connectorWide) return false;
    if (known.repositoryId) {
      if (grant.repositoryIds.has(known.repositoryId)) return false;
      return grant.containerIds.size > 0;
    }
    return grant.containerIds.size > 0 || grant.repositoryIds.size > 0;
  });
}

/**
 * Who a Git check runs for. `scopes` are the request's scopes; `accountScopes` are the live scopes of the
 * account behind a token or OAuth grant. A token keeps narrow Git scopes its owner holds only through a
 * containing group or owner (boundScopes step 4), so every repository check of a token caller requires both
 * sets to cover the repository.
 */
export interface GitPrincipal {
  scopes: readonly string[];
  accountScopes?: readonly string[] | null;
}

function scopeSetsOf(principal: GitPrincipal): (readonly string[])[] {
  return principal.accountScopes ? [principal.scopes, principal.accountScopes] : [principal.scopes];
}

/** hasGitRepositoryScope for the request scopes and, for token callers, the owner's current scopes. */
export function principalHasGitRepositoryScope(
  principal: GitPrincipal,
  requiredScope: string,
  target: GitRepositoryScopeTarget
): boolean {
  return scopeSetsOf(principal).every((scopes) => hasGitRepositoryScope(scopes, requiredScope, target));
}

/** hasGitScopeOnConnector for every scope set of the principal. */
export function principalHasGitScopeOnConnector(
  principal: GitPrincipal,
  requiredScope: string,
  connectorId: string
): boolean {
  return scopeSetsOf(principal).every((scopes) => hasGitScopeOnConnector(scopes, requiredScope, connectorId));
}

/** One grant summary per scope set: a repository is covered only when every one covers it. */
export function principalGitConnectorGrants(
  principal: GitPrincipal,
  requiredScope: string,
  connectorId: string
): GitConnectorGrant[] {
  return scopeSetsOf(principal).map((scopes) => gitConnectorGrant(scopes, requiredScope, connectorId));
}

/** Whether every grant names something on the connector. */
export function hasGitGrants(grants: readonly GitConnectorGrant[]): boolean {
  return grants.every(hasGitGrant);
}

/** Whether every grant is connector-wide (no per-repository filtering needed). */
export function gitGrantsConnectorWide(grants: readonly GitConnectorGrant[]): boolean {
  return grants.every((grant) => grant.connectorWide);
}

/** Whether every grant covers a repository whose containers are known. */
export function gitGrantsCover(
  grants: readonly GitConnectorGrant[],
  target: Omit<GitRepositoryScopeTarget, 'connectorId'>
): boolean {
  return grants.every((grant) => gitGrantCovers(grant, target));
}

/** gitGrantNeedsLookup for any scope set of the principal. */
export function principalGitGrantNeedsLookup(
  principal: GitPrincipal,
  requiredScopes: readonly string[],
  connectorId: string,
  known: { repositoryId?: string | null } = {}
): boolean {
  return scopeSetsOf(principal).some((scopes) => gitGrantNeedsLookup(scopes, requiredScopes, connectorId, known));
}
