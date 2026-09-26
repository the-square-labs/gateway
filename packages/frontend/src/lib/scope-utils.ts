import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE } from "@/types/scope-implications";
import { GIT_TARGET_SCOPES } from "@/types/scope-resource-restrictions";

const RESOURCE_SCOPABLE_BY_LENGTH = [...RESOURCE_SCOPABLE_SCOPES].sort(
  (a, b) => b.length - a.length
);
const ALL_SCOPE_VALUES = new Set<string>(TOKEN_SCOPES.map((scope) => scope.value));

const DOCKER_CHILD_SCOPE_PREFIXES = [
  "docker:containers:",
  "docker:compose:",
  "docker:networks:",
  "docker:volumes:",
  "docker:images:",
  "docker:availability:",
] as const;

const GIT_TARGET_SCOPE_SET = new Set<string>(GIT_TARGET_SCOPES);

function parentResourceId(baseScope: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  // A Git connector qualifier covers its groups, projects, owners and repositories
  // (`<connectorId>/group/<id>`). Group and owner ancestry is resolved by the API.
  if (GIT_TARGET_SCOPE_SET.has(baseScope)) {
    const separator = resourceId.indexOf("/");
    return separator > 0 ? resourceId.slice(0, separator) : null;
  }
  if (!DOCKER_CHILD_SCOPE_PREFIXES.some((prefix) => baseScope.startsWith(prefix))) return null;
  if (resourceId.startsWith("folder/") || resourceId.startsWith("node/")) return null;
  const separator = resourceId.indexOf("/");
  return separator > 0 ? resourceId.slice(0, separator) : null;
}

const RESOURCE_SCOPABLE_SET = new Set<string>(RESOURCE_SCOPABLE_SCOPES);
/** The most `:`-separated segments any resource-scopable base has (a qualified scope has more). */
const RESOURCE_SCOPABLE_MAX_SEGMENTS = Math.max(
  ...RESOURCE_SCOPABLE_SCOPES.map((scope) => scope.split(":").length)
);

/** Longest resource-scopable prefix with a non-empty qualifier (mirrors the backend; a few lookups per call). */
export function extractBaseScope(scope: string): string {
  if (ALL_SCOPE_VALUES.has(scope)) return scope;
  const separators: number[] = [];
  for (
    let index = 0;
    index < scope.length && separators.length < RESOURCE_SCOPABLE_MAX_SEGMENTS;
    index += 1
  ) {
    if (scope.charCodeAt(index) === 58) separators.push(index);
  }
  for (let candidate = separators.length - 1; candidate >= 0; candidate -= 1) {
    const end = separators[candidate];
    const base = scope.slice(0, end);
    if (RESOURCE_SCOPABLE_SET.has(base) && scope.length > end + 1) return base;
  }
  return scope;
}

export function scopeMatches(availableScopes: readonly string[], requiredScope: string): boolean {
  if (availableScopes.includes(requiredScope)) return true;
  const base = extractBaseScope(requiredScope);
  if (base !== requiredScope && availableScopes.includes(base)) return true;
  if (base !== requiredScope) {
    const parentId = parentResourceId(base, requiredScope.slice(base.length + 1));
    if (parentId && availableScopes.includes(`${base}:${parentId}`)) return true;
  }
  return hasImpliedScope(availableScopes, requiredScope);
}

export function hasScopeBase(availableScopes: readonly string[], baseScope: string): boolean {
  if (scopeMatches(availableScopes, baseScope)) return true;
  return availableScopes.some((scope) => {
    const scopeBase = extractBaseScope(scope);
    if (scope === scopeBase) return false;
    const resourceId = scope.slice(scopeBase.length + 1);
    return scopeMatches([scope], `${baseScope}:${resourceId}`);
  });
}

export function canCreateInFolder(
  scopes: readonly string[],
  base: string,
  folderId: string | null | undefined,
  nodeId?: string
): boolean {
  return (
    scopeMatches(scopes, base) ||
    (!!nodeId &&
      (scopeMatches(scopes, `${base}:${nodeId}`) ||
        scopeMatches(scopes, `${base}:node/${nodeId}`))) ||
    (!!folderId && scopeMatches(scopes, `${base}:folder/${folderId}`))
  );
}

function hasImpliedScope(availableScopes: readonly string[], requiredScope: string): boolean {
  const requiredBase = extractBaseScope(requiredScope);
  // Transitive closure generated from the backend catalog (see types/scope-implications.ts).
  const impliedScopes = IMPLIED_SCOPES_BY_REQUIRED_SCOPE[requiredBase];
  if (!impliedScopes) return false;

  const resourceId =
    requiredBase === requiredScope ? null : requiredScope.slice(requiredBase.length + 1);

  const parentId = parentResourceId(requiredBase, resourceId);
  return impliedScopes.some(
    (impliedScope) =>
      availableScopes.includes(impliedScope) ||
      (resourceId !== null && availableScopes.includes(`${impliedScope}:${resourceId}`)) ||
      (parentId !== null && availableScopes.includes(`${impliedScope}:${parentId}`))
  );
}

export function hasSelectableScopeBase(
  availableScopes: readonly string[],
  baseScope: string
): boolean {
  if (hasScopeBase(availableScopes, baseScope)) return true;
  return availableScopes.some(
    (availableScope) =>
      extractBaseScope(availableScope) === baseScope && availableScope !== baseScope
  );
}

export function deriveAllowedResourceIdsByScope(userScopes: readonly string[]) {
  const result: Record<string, string[]> = {};
  for (const scope of RESOURCE_SCOPABLE_SCOPES) {
    if (userScopes.includes(scope)) continue;
    const ids = userScopes.flatMap((candidate) => {
      const candidateBase = extractBaseScope(candidate);
      if (candidate === candidateBase) return [];
      const id = candidate.slice(candidateBase.length + 1);
      return id && scopeMatches([candidate], `${scope}:${id}`) ? [id] : [];
    });
    if (ids.length > 0) result[scope] = [...new Set(ids)];
  }
  return result;
}

export function parseScopesForForm(scopes: readonly string[]) {
  const baseScopes: string[] = [];
  const resources: Record<string, string[]> = {};
  const restrictableScopeSet = new Set<string>(RESOURCE_SCOPABLE_SCOPES);

  for (const scope of scopes) {
    // A complete scope wins over prefix matching, like extractBaseScope does:
    // "admin:users:folders:manage" is its own scope, not "admin:users"
    // restricted to a resource named "folders:manage".
    if (restrictableScopeSet.has(scope) || ALL_SCOPE_VALUES.has(scope)) {
      if (!baseScopes.includes(scope)) baseScopes.push(scope);
      continue;
    }

    const base = RESOURCE_SCOPABLE_BY_LENGTH.find(
      (candidate) => scope.startsWith(`${candidate}:`) && scope.length > candidate.length + 1
    );
    if (!base) {
      if (!baseScopes.includes(scope)) baseScopes.push(scope);
      continue;
    }

    if (!baseScopes.includes(base)) baseScopes.push(base);
    resources[base] = [...new Set([...(resources[base] ?? []), scope.slice(base.length + 1)])];
  }

  return { baseScopes, resources };
}

export function buildFinalScopes(
  baseScopes: readonly string[],
  resources: Record<string, string[]>
) {
  const exact = new Set<string>();
  const scoped = new Map<string, Set<string>>();

  for (const scope of baseScopes) {
    const selectedResources = resources[scope] ?? [];
    if (selectedResources.length === 0) {
      exact.add(scope);
      continue;
    }
    if (!scoped.has(scope)) scoped.set(scope, new Set());
    for (const resourceId of selectedResources) scoped.get(scope)!.add(`${scope}:${resourceId}`);
  }

  const finalScopes = new Set<string>(exact);
  for (const [base, values] of scoped.entries()) {
    if (exact.has(base)) continue;
    for (const value of values) finalScopes.add(value);
  }

  return [...finalScopes].sort();
}

export function canonicalizeScopeSelection(scopes: readonly string[]): string[] {
  const exactScopes = new Set<string>();
  const resourceScopes = new Map<string, Set<string>>();

  for (const scope of scopes) {
    const base = extractBaseScope(scope);
    if (scope === base) {
      exactScopes.add(scope);
      continue;
    }
    if (!resourceScopes.has(base)) resourceScopes.set(base, new Set());
    resourceScopes.get(base)!.add(scope);
  }

  const result = new Set(exactScopes);
  for (const [base, values] of resourceScopes.entries()) {
    if (exactScopes.has(base)) continue;
    for (const value of values) result.add(value);
  }
  return [...result].sort();
}

export function requiresResourceSelection(
  scope: string,
  allowedResourceIdsByScope: Record<string, string[]>,
  _initialResourceLimitedScopes: readonly string[]
) {
  return (allowedResourceIdsByScope[scope]?.length ?? 0) > 0;
}
