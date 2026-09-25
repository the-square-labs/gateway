/**
 * Scope-based permission helpers.
 * Replaces the old role-based helpers (hasRole, canManageCAs, etc.)
 */

import { isFolderScopedScope } from './folder-scopes.js';
import { canonicalizeScopes, extractBaseScope, isValidBaseScope, MANUAL_APPROVAL_SCOPE_SET } from './scopes.js';
import { scopeCleanupAdditions } from './scopes-aliases.js';
import { PROGRAMMATIC_DENIED_SCOPE_SET } from './scopes-base.js';
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE } from './scopes-implications.js';

/** Reverse of the implication closure: scope -> the required scopes it satisfies. */
const IMPLIED_BY_SCOPE = new Map<string, string[]>();
for (const [required, implying] of Object.entries(IMPLIED_SCOPES_BY_REQUIRED_SCOPE)) {
  for (const scope of implying) IMPLIED_BY_SCOPE.set(scope, [...(IMPLIED_BY_SCOPE.get(scope) ?? []), required]);
}

const DOCKER_CHILD_SCOPE_PREFIXES = [
  'docker:containers:',
  'docker:compose:',
  'docker:networks:',
  'docker:volumes:',
  'docker:images:',
  'docker:availability:',
] as const;

function parentResourceId(baseScope: string, resourceId: string | null): string | null {
  if (!DOCKER_CHILD_SCOPE_PREFIXES.some((prefix) => baseScope.startsWith(prefix))) return null;
  if (!resourceId) return null;
  if (resourceId.startsWith('folder/') || resourceId.startsWith('node/')) return null;
  const separator = resourceId.indexOf('/');
  return separator > 0 ? resourceId.slice(0, separator) : null;
}

type ScopeMembership = (scope: string) => boolean;

function hasImpliedScope(holds: ScopeMembership, requiredScope: string): boolean {
  const requiredBase = extractBaseScope(requiredScope);
  // Precomputed transitive closure generated from the catalog (see scopes-implications.ts).
  const impliedScopes = IMPLIED_SCOPES_BY_REQUIRED_SCOPE[requiredBase];
  if (!impliedScopes) return false;

  const resourceId = requiredBase === requiredScope ? null : requiredScope.slice(requiredBase.length + 1);
  const parentId = parentResourceId(requiredBase, resourceId);
  for (const impliedScope of impliedScopes) {
    if (holds(impliedScope)) return true;
    if (resourceId && holds(`${impliedScope}:${resourceId}`)) return true;
    if (parentId && holds(`${impliedScope}:${parentId}`)) return true;
  }
  return false;
}

/** hasScope over any membership test: an array scan for small lists, a Set for large ones. */
function matchesScope(holds: ScopeMembership, requiredScope: string): boolean {
  if (holds(requiredScope)) return true;

  const baseScope = extractBaseScope(requiredScope);
  if (baseScope !== requiredScope) {
    if (holds(baseScope)) return true;
    const resourceId = requiredScope.slice(baseScope.length + 1);
    const parentId = parentResourceId(baseScope, resourceId);
    if (parentId && holds(`${baseScope}:${parentId}`)) return true;
    return hasImpliedScope(holds, requiredScope);
  }

  if (hasImpliedScope(holds, requiredScope)) return true;

  if (isValidBaseScope(requiredScope)) return false;

  const parts = requiredScope.split(':');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (holds(parts.slice(0, i).join(':'))) return true;
  }

  return false;
}

/**
 * Check if a set of scopes grants a required permission.
 * Supports hierarchical matching: 'cert:issue' grants 'cert:issue:ca-123'
 */
export function hasScope(scopes: readonly string[], requiredScope: string): boolean {
  return matchesScope((scope) => scopes.includes(scope), requiredScope);
}

/**
 * A reusable hasScope for one large scope list (expanded folder grants can hold thousands):
 * every check is a handful of Set lookups instead of array scans.
 */
export function scopeMatcher(scopes: readonly string[]): (requiredScope: string) => boolean {
  const held = new Set(scopes);
  const holds: ScopeMembership = (scope) => held.has(scope);
  return (requiredScope) => matchesScope(holds, requiredScope);
}

/** Check if scopes contain a broad scope or any resource-scoped variant of it. */
export function hasScopeBase(scopes: string[], baseScope: string): boolean {
  if (hasScope(scopes, baseScope)) return true;
  return scopes.some((scope) => {
    const scopeBase = extractBaseScope(scope);
    if (scope === scopeBase) return false;
    const resourceId = scope.slice(scopeBase.length + 1);
    return hasScope([scope], `${baseScope}:${resourceId}`);
  });
}

/** Check if scopes grant a broad scope or a specific resource-scoped variant. */
export function hasScopeForResource(scopes: string[], baseScope: string, resourceId: string): boolean {
  return hasScope(scopes, baseScope) || (!!resourceId && hasScope(scopes, `${baseScope}:${resourceId}`));
}

/** Authorize creation in a destination, never via an existing child resource grant.
 * Folder descendants must already have been expanded by the authentication layer.
 * Callers validate destination existence/family before performing side effects.
 */
export function hasScopeForCreation(
  scopes: readonly string[],
  baseScope: string,
  folderId: string | null | undefined,
  resourceId?: string
): boolean {
  const grants = [...scopes];
  return (
    hasScope(grants, baseScope) ||
    (!!resourceId &&
      !resourceId.includes('/') &&
      (hasScope(grants, `${baseScope}:${resourceId}`) || hasScope(grants, `${baseScope}:node/${resourceId}`))) ||
    (!!folderId && !folderId.includes('/') && hasScope(grants, `${baseScope}:folder/${folderId}`))
  );
}

/** Return resource IDs from scoped grants that satisfy baseScope:<id>. */
export function getResourceScopedIds(scopes: readonly string[], baseScope: string): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (isFolderScopedScope(scope)) continue;
    const scopeBase = extractBaseScope(scope);
    if (scope === scopeBase) continue;
    const resourceId = scope.slice(scopeBase.length + 1);
    if (resourceId.startsWith('node/') || resourceId.startsWith('provider/') || resourceId.startsWith('account/'))
      continue;
    if (resourceId && hasScope([scope], `${baseScope}:${resourceId}`)) ids.add(resourceId);
  }
  return [...ids];
}

/** Check if scopes grant any of the required scopes */
export function hasAnyScope(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.some((s) => hasScope(scopes, s));
}

/** Check if scopes grant all of the required scopes */
export function hasAllScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((s) => hasScope(scopes, s));
}

/** Check if a user can use the AI assistant */
export function canUseAI(scopes: string[]): boolean {
  return hasScope(scopes, 'ai:workspace:use');
}

/**
 * Add the grants migration 0200 gave holders of these scopes (for example `integrations:github:manage`
 * brings repository reads), keeping only additions the requester can delegate. Used where new
 * credentials are minted, so older scripts keep the capabilities they expect. Manual-approval scopes
 * (CA key export, repository writes, ...) are never added implicitly: they must be asked for.
 */
export function withDelegableCleanupAdditions(scopes: readonly string[], holderScopes: readonly string[]): string[] {
  const holds = scopeMatcher(holderScopes);
  const additions = scopes
    .flatMap(scopeCleanupAdditions)
    .filter((scope) => !MANUAL_APPROVAL_SCOPE_SET.has(extractBaseScope(scope)) && holds(scope));
  return additions.length === 0 ? [...scopes] : canonicalizeScopes([...scopes, ...additions]);
}

/** Check if all requested scopes are a subset of the allowed scopes */
export function isScopeSubset(requestedScopes: readonly string[], allowedScopes: readonly string[]): boolean {
  if (requestedScopes.length === 0) return true;
  // Both lists can be expanded folder grants (user management compares whole effective scope sets).
  const allowed = scopeMatcher(allowedScopes);
  return requestedScopes.every((scope) => allowed(scope));
}

/**
 * Bound delegated scopes by the principal's current scopes.
 *
 * This is not a simple array intersection because scopes are hierarchical:
 * a broad token scope plus a resource-scoped user scope should still allow
 * that specific resource, and vice versa.
 */
export function boundScopes(delegatedScopes: readonly string[], principalScopes: readonly string[]): string[] {
  // Near-linear: expanded token and owner scope lists can each hold thousands of entries, and this
  // runs on every token request. Every step uses Set lookups instead of nested scans.
  const bounded = new Set<string>();
  const principalHolds = scopeMatcher(principalScopes);
  const delegatedSet = new Set(delegatedScopes);

  // 1. Delegated scopes the principal holds (broadly, per resource, through a parent or an implication).
  for (const scope of delegatedScopes) {
    if (principalHolds(scope)) bounded.add(scope);
  }

  // 2. Principal scopes a delegated scope of the same base covers (the same scope, its broad form, or its
  //    Docker node parent): a broad token keeps exactly the owner's per-resource grants.
  for (const scope of principalScopes) {
    const scopeBase = extractBaseScope(scope);
    if (delegatedSet.has(scope)) {
      bounded.add(scope);
      continue;
    }
    if (scope === scopeBase) continue;
    const resourceId = scope.slice(scopeBase.length + 1);
    const parentId = parentResourceId(scopeBase, resourceId);
    if (delegatedSet.has(scopeBase) || (parentId && delegatedSet.has(`${scopeBase}:${parentId}`))) {
      bounded.add(scope);
    }
  }

  // 3. A broad delegated scope narrowed to the resources the principal holds it for, directly or through a
  //    scope that implies it (`proxy:view` + owner `proxy:edit:<id>` -> `proxy:view:<id>`).
  for (const principalScope of principalScopes) {
    const principalBase = extractBaseScope(principalScope);
    if (principalScope === principalBase) continue;
    const resourceId = principalScope.slice(principalBase.length + 1);
    for (const delegatedBase of [principalBase, ...(IMPLIED_BY_SCOPE.get(principalBase) ?? [])]) {
      if (!delegatedSet.has(delegatedBase)) continue;
      const narrowedDelegatedScope = `${delegatedBase}:${resourceId}`;
      if (hasScope([principalScope], narrowedDelegatedScope)) bounded.add(narrowedDelegatedScope);
    }
  }

  return [...bounded];
}

/**
 * Scopes used for "cannot touch what you do not hold" checks. A programmatic caller can never hold the
 * account-only scopes (AI workspace, impersonation, ...), so those come from the live account behind it.
 */
export function privilegeBoundaryScopes(
  actorScopes: string[],
  accountScopes?: string[],
  purpose: 'manage' | 'grant' = 'manage'
): string[] {
  if (!accountScopes) return actorScopes;
  return [
    ...actorScopes,
    ...accountScopes.filter((scope) => {
      const base = extractBaseScope(scope);
      // A programmatic caller may never hand out impersonation, even when its owner holds it.
      if (purpose === 'grant' && base.startsWith('admin:users:impersonate')) return false;
      return PROGRAMMATIC_DENIED_SCOPE_SET.has(base);
    }),
  ];
}

/**
 * Check if actor can manage target based on scope containment.
 * Returns null if allowed, or an error message string if denied.
 *
 * Rules:
 * 1. Target has admin:system → actor must also have admin:system
 * 2. Target's scopes must be a subset of actor's scopes
 *    (you can't touch someone who has permissions you lack)
 */
export function canManageUser(actorScopes: string[], targetScopes: string[]): string | null {
  // Rule 1: admin:system is a hard shield
  if (targetScopes.includes('admin:system') && !actorScopes.includes('admin:system')) {
    return 'Cannot manage a system administrator';
  }

  // Rule 2: target's scopes must be contained by actor's scopes
  if (!isScopeSubset(targetScopes, actorScopes)) {
    return 'Cannot manage a user with permissions you do not possess';
  }

  return null;
}
