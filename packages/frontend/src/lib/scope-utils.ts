import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";

const RESOURCE_SCOPABLE_BY_LENGTH = [...RESOURCE_SCOPABLE_SCOPES].sort(
  (a, b) => b.length - a.length
);
const ALL_SCOPE_VALUES = new Set<string>(TOKEN_SCOPES.map((scope) => scope.value));

function parentResourceId(baseScope: string, resourceId: string | null): string | null {
  if (!baseScope.startsWith("docker:containers:")) return null;
  if (!resourceId) return null;
  const separator = resourceId.indexOf("/");
  return separator > 0 ? resourceId.slice(0, separator) : null;
}
const IMPLIED_SCOPES_BY_REQUIRED_SCOPE: Record<string, readonly string[]> = {
  "domains:view": ["domains:edit"],
  "pki:templates:view": ["pki:templates:edit"],
  "proxy:view": ["proxy:edit"],
  "pages:view": [
    "pages:edit",
    "pages:delete",
    "pages:deploy",
    "pages:deployments:manage",
    "pages:tags:manage",
    "pages:tokens:manage",
  ],
  "pages:settings:view": ["pages:settings:edit"],
  "proxy:templates:view": ["proxy:templates:edit"],
  "acl:view": ["acl:edit"],
  "nodes:details": ["nodes:rename"],
  "nodes:config:view": ["nodes:config:edit"],
  "settings:gateway:view": ["settings:gateway:edit"],
  "housekeeping:view": ["housekeeping:run", "housekeeping:configure"],
  "license:view": ["license:manage"],
  "docker:containers:view": [
    "docker:containers:edit",
    "docker:containers:config",
    "docker:containers:manage",
    "docker:containers:console",
    "docker:containers:files",
    "docker:containers:environment",
    "docker:containers:secrets",
    "docker:containers:webhooks",
  ],
  "docker:networks:view": ["docker:networks:edit"],
  "docker:registries:view": ["docker:registries:edit"],
  "databases:view": [
    "databases:edit",
    "databases:query:read",
    "databases:query:write",
    "databases:query:admin",
  ],
  "databases:query:read": ["databases:query:write", "databases:query:admin"],
  "databases:query:write": ["databases:query:admin"],
  "notifications:alerts:view": ["notifications:alerts:edit"],
  "notifications:webhooks:view": ["notifications:webhooks:edit"],
  "notifications:view": ["notifications:manage"],
  "audit:siem:view": ["audit:siem:manage"],
  "logs:environments:view": ["logs:environments:edit", "logs:read"],
  "logs:tokens:view": ["logs:manage"],
  "logs:schemas:view": ["logs:schemas:edit"],
  "logs:read": ["logs:manage"],
  "status-page:view": ["status-page:manage"],
  "integrations:cloudflare:view": ["integrations:cloudflare:manage"],
  "integrations:github:view": ["integrations:github:manage"],
  "integrations:git:view": ["integrations:git:manage"],
  "integrations:ssh:view": ["integrations:ssh:manage"],
  "integrations:cloudflare:dns:view": [
    "integrations:cloudflare:manage",
    "integrations:cloudflare:dns:edit",
    "integrations:cloudflare:dns:delete",
  ],
  "inference:providers:view": ["inference:providers:manage", "inference:models:manage"],
};

export function extractBaseScope(scope: string): string {
  if (ALL_SCOPE_VALUES.has(scope)) return scope;
  const base = RESOURCE_SCOPABLE_BY_LENGTH.find(
    (candidate) => scope.startsWith(`${candidate}:`) && scope.length > candidate.length + 1
  );
  return base ?? scope;
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

function hasImpliedScope(availableScopes: readonly string[], requiredScope: string): boolean {
  const requiredBase = extractBaseScope(requiredScope);
  const impliedScopes = getTransitiveImpliedScopes(requiredBase);
  if (impliedScopes.length === 0) return false;

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

function getTransitiveImpliedScopes(requiredBase: string): string[] {
  const result = new Set<string>();
  const queue = [...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[requiredBase] ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const scope = queue[index];
    if (result.has(scope)) continue;
    result.add(scope);
    queue.push(...(IMPLIED_SCOPES_BY_REQUIRED_SCOPE[scope] ?? []));
  }
  return [...result];
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
    if (restrictableScopeSet.has(scope)) {
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
