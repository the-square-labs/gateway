/**
 * Git integration scope qualifiers (grammar only; matching lives in git-scopes.ts).
 *
 * Qualifiers are stable IDs, never names or paths:
 * - `<connectorId>`: every repository of one connector;
 * - GitLab `<connectorId>/group/<groupId>` (the group, its subgroups and their projects) or
 *   `<connectorId>/project/<projectId>`;
 * - GitHub `<connectorId>/owner/<ownerId>` (an organization or user) or `<connectorId>/repo/<repoId>`;
 * - generic Git takes the connector only.
 * Connector administration (`manage`) is unqualified or connector-level only.
 */

export const GIT_SCOPE_PROVIDERS = ['gitlab', 'github', 'git'] as const;
export type GitScopeProvider = (typeof GIT_SCOPE_PROVIDERS)[number];

/**
 * Scopes a connector, group/owner or project/repository qualifier can limit. The order matches the
 * frontend `GIT_TARGET_SCOPES` list (scope-resource-restrictions.ts).
 */
export const GIT_REPOSITORY_SCOPABLE = [
  'integrations:gitlab:view',
  'integrations:gitlab:use',
  'integrations:gitlab:repo:read',
  'integrations:gitlab:repo:write',
  'integrations:gitlab:sandbox:clone',
  'integrations:github:view',
  'integrations:github:use',
  'integrations:github:repo:read',
  'integrations:github:repo:write',
  'integrations:git:view',
  'integrations:git:use',
  'integrations:git:repo:read',
  'integrations:git:repo:write',
] as const;

/** Connector administration: unqualified, or limited to one connector. */
export const GIT_CONNECTOR_SCOPABLE = [
  'integrations:gitlab:manage',
  'integrations:github:manage',
  'integrations:git:manage',
] as const;

export const GIT_SCOPABLE: readonly string[] = [...GIT_REPOSITORY_SCOPABLE, ...GIT_CONNECTOR_SCOPABLE];

export type GitQualifierKind = 'connector' | 'group' | 'project' | 'owner' | 'repo';

/** The container (group/owner) and repository (project/repo) qualifier names of each provider. */
export const GIT_TARGET_KINDS: Readonly<
  Record<GitScopeProvider, { container: 'group' | 'owner'; repository: 'project' | 'repo' } | null>
> = {
  gitlab: { container: 'group', repository: 'project' },
  github: { container: 'owner', repository: 'repo' },
  git: null,
};

export interface GitScopeQualifier {
  connectorId: string;
  kind: GitQualifierKind;
  /** The group, project, owner or repository ID; null for a connector qualifier. */
  id: string | null;
}

const GIT_SCOPABLE_SET = new Set<string>(GIT_SCOPABLE);
const GIT_CONNECTOR_SCOPABLE_SET = new Set<string>(GIT_CONNECTOR_SCOPABLE);
/** Connector IDs are stored lowercase; an uppercase qualifier would never match a request. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^[1-9][0-9]{0,19}$/;
const QUALIFIER_KINDS = new Set<string>(['group', 'project', 'owner', 'repo']);

/** Whether a base scope takes Git qualifiers. */
export function isGitScopeBase(base: string): boolean {
  return GIT_SCOPABLE_SET.has(base);
}

/** The provider of a Git base scope (`integrations:<provider>:...`), or null for any other scope. */
export function gitScopeProviderOf(base: string): GitScopeProvider | null {
  if (!GIT_SCOPABLE_SET.has(base)) return null;
  return base.split(':')[1] as GitScopeProvider;
}

/** Parse a qualifier's shape without checking which provider may use it. */
export function parseGitScopeQualifier(qualifier: string): GitScopeQualifier | null {
  const segments = qualifier.split('/');
  if (!UUID.test(segments[0] ?? '')) return null;
  if (segments.length === 1) return { connectorId: segments[0], kind: 'connector', id: null };
  if (segments.length !== 3 || !QUALIFIER_KINDS.has(segments[1]) || !PROVIDER_ID.test(segments[2])) return null;
  return { connectorId: segments[0], kind: segments[1] as GitQualifierKind, id: segments[2] };
}

/** Why a qualifier cannot follow a Git base scope, or null when it can. */
export function gitScopeQualifierIssue(base: string, qualifier: string): string | null {
  const provider = gitScopeProviderOf(base);
  if (!provider) return `${base} is not a Git integration scope`;
  const parsed = parseGitScopeQualifier(qualifier);
  const kinds = GIT_TARGET_KINDS[provider];
  if (GIT_CONNECTOR_SCOPABLE_SET.has(base) || !kinds) {
    return parsed?.kind === 'connector' ? null : `${base} can only be restricted to a connector: <connectorId>`;
  }
  const expected = `<connectorId>, <connectorId>/${kinds.container}/<id> or <connectorId>/${kinds.repository}/<id>`;
  if (!parsed) return `Git scope targets must be ${expected}`;
  if (parsed.kind === 'connector' || parsed.kind === kinds.container || parsed.kind === kinds.repository) return null;
  return `${base} targets must be ${expected}`;
}
