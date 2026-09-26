import { z } from 'zod';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Git scope picker (`GET /integrations/{provider}/{connectorId}/scope-targets[/resolve]`): the groups,
 * projects, owners and repositories a Git scope can be limited to, and labels for stored qualifiers.
 * Results only name what the caller may see through its own `integrations:<provider>:view` grants
 * (implied by any other Git scope on the same qualifier).
 */

export const SCOPE_TARGET_PROVIDERS = ['gitlab', 'github'] as const;
export type ScopeTargetProvider = (typeof SCOPE_TARGET_PROVIDERS)[number];

export const SCOPE_TARGET_DEFAULT_LIMIT = 50;
export const SCOPE_TARGET_MAX_LIMIT = 100;
export const SCOPE_TARGET_MAX_RESOLVE_IDS = 100;
/** Provider search results are cached per connector, search text and limit. */
export const SCOPE_TARGET_SEARCH_TTL_MS = 60_000;
/** Group, project, owner and repository lookups (labels and GitLab ancestry). */
export const SCOPE_TARGET_LOOKUP_TTL_MS = 5 * 60_000;
/** Uncached provider lookups one picker request may make (labels, group parents); the rest stay unlabeled. */
export const SCOPE_TARGET_LOOKUP_BUDGET = 60;
/** Picker requests (search and resolve together) per principal and window. */
export const SCOPE_TARGET_RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 } as const;

/** A fixed-window request limit per principal for the scope picker (it spends the connector's API budget). */
export class ScopeTargetRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: { windowMs: number; maxRequests: number } = SCOPE_TARGET_RATE_LIMIT,
    private readonly now: () => number = Date.now
  ) {}

  consume(principal: string): void {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [key, window] of this.windows) {
        if (now - window.start >= this.limit.windowMs) this.windows.delete(key);
      }
    }
    const window = this.windows.get(principal);
    if (!window || now - window.start >= this.limit.windowMs) {
      this.windows.set(principal, { start: now, count: 1 });
      return;
    }
    if (window.count >= this.limit.maxRequests) {
      throw new AppError(429, 'SCOPE_TARGET_RATE_LIMITED', 'Too many scope picker requests, try again shortly', {
        retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.limit.windowMs - now) / 1000)),
      });
    }
    window.count += 1;
  }

  reset(): void {
    this.windows.clear();
  }
}

export const scopeTargetRateLimiter = new ScopeTargetRateLimiter();

export const ScopeTargetParamsSchema = z.object({
  provider: z.enum(SCOPE_TARGET_PROVIDERS),
  connectorId: z.string().uuid(),
});

export const ScopeTargetSearchQuerySchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  limit: z.coerce.number().int().min(1).max(SCOPE_TARGET_MAX_LIMIT).optional().default(SCOPE_TARGET_DEFAULT_LIMIT),
});
export type ScopeTargetSearchQuery = z.infer<typeof ScopeTargetSearchQuerySchema>;

export const ScopeTargetResolveQuerySchema = z.object({
  ids: z.string().trim().min(1).max(4096),
});

export const GitLabScopeTargetsSchema = z.object({
  groups: z.array(z.object({ id: z.string(), fullPath: z.string(), name: z.string() })),
  projects: z.array(z.object({ id: z.string(), pathWithNamespace: z.string(), name: z.string() })),
});
export type GitLabScopeTargets = z.infer<typeof GitLabScopeTargetsSchema>;

export const GitHubScopeTargetsSchema = z.object({
  owners: z.array(z.object({ id: z.string(), login: z.string(), type: z.string() })),
  repos: z.array(z.object({ id: z.string(), fullName: z.string() })),
});
export type GitHubScopeTargets = z.infer<typeof GitHubScopeTargetsSchema>;

export const ScopeTargetResolutionSchema = z.object({
  items: z.array(
    z.object({
      qualifier: z.string(),
      label: z.string(),
      missing: z.boolean(),
    })
  ),
});
export type ScopeTargetResolution = z.infer<typeof ScopeTargetResolutionSchema>;
export type ScopeTargetResolutionItem = ScopeTargetResolution['items'][number];

export interface ParsedScopeTargetId {
  qualifier: string;
  kind: 'group' | 'project' | 'owner' | 'repo';
  id: string;
}

const KINDS: Record<ScopeTargetProvider, readonly ParsedScopeTargetId['kind'][]> = {
  gitlab: ['group', 'project'],
  github: ['owner', 'repo'],
};
const PROVIDER_ID = /^[1-9][0-9]{0,19}$/;

/** Parse `ids=group/123,project/456` (qualifiers relative to the connector); duplicates are dropped. */
export function parseScopeTargetIds(provider: ScopeTargetProvider, raw: string): ParsedScopeTargetId[] {
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
  if (values.length === 0 || values.length > SCOPE_TARGET_MAX_RESOLVE_IDS) {
    throw new AppError(
      400,
      'INVALID_SCOPE_TARGET',
      `Pass between 1 and ${SCOPE_TARGET_MAX_RESOLVE_IDS} comma-separated qualifiers`
    );
  }
  const kinds = KINDS[provider];
  return values.map((qualifier) => {
    const [kind, id, ...rest] = qualifier.split('/');
    if (rest.length > 0 || !kinds.includes(kind as ParsedScopeTargetId['kind']) || !PROVIDER_ID.test(id ?? '')) {
      throw new AppError(
        400,
        'INVALID_SCOPE_TARGET',
        `Scope target qualifiers must be ${kinds.map((value) => `${value}/<id>`).join(' or ')}: ${qualifier}`
      );
    }
    return { qualifier, kind: kind as ParsedScopeTargetId['kind'], id };
  });
}

/** Case-insensitive substring search over the given labels; an empty search matches everything. */
export function matchesScopeTargetSearch(search: string, ...labels: string[]): boolean {
  const needle = search.trim().toLowerCase();
  return !needle || labels.some((label) => label.toLowerCase().includes(needle));
}

/** Whether a GitLab path is the group path itself or lies under it. */
export function isUnderGitLabPath(path: string, groupPath: string): boolean {
  const normalizedPath = path.toLowerCase();
  const normalizedGroup = groupPath.toLowerCase();
  return normalizedPath === normalizedGroup || normalizedPath.startsWith(`${normalizedGroup}/`);
}

/** A stored qualifier the caller may not see: its raw ID only, never a provider name or path. */
export function unresolvedScopeTarget(qualifier: string): ScopeTargetResolutionItem {
  return { qualifier, label: qualifier, missing: false };
}
