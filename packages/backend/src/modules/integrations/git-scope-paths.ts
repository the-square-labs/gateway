import { container } from '@/container.js';
import { extractBaseScope } from '@/lib/scopes.js';
import {
  gitScopePathQualifierIssue,
  gitScopeProviderOf,
  isGitScopeBase,
  parseGitScopePathQualifier,
} from '@/lib/scopes-git.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { ScopeTargetLookup } from './git-scope-targets.js';
import type { IntegrationsService } from './integrations.service.js';

type PathKind = 'group' | 'project' | 'owner' | 'repo';

const PROVIDER_KINDS: Record<'gitlab' | 'github', readonly PathKind[]> = {
  gitlab: ['group', 'project'],
  github: ['owner', 'repo'],
};

/** Loaded on first use: permission saves import this module, and most never carry a path qualifier. */
async function integrationsService(): Promise<IntegrationsService> {
  const { IntegrationsService: Service } = await import('./integrations.service.js');
  return container.resolve(Service);
}

/**
 * The stable qualifier of a GitLab group or project, or a GitHub owner or repository, at a path the caller may
 * view on one connector. Shared by the REST lookup, the MCP tool and path qualifiers on save.
 */
export async function lookupGitScopeTargetPath(
  user: User,
  provider: 'gitlab' | 'github',
  connectorId: string,
  kind: PathKind,
  path: string,
  service?: IntegrationsService
): Promise<ScopeTargetLookup> {
  if (!PROVIDER_KINDS[provider].includes(kind)) {
    throw new AppError(
      400,
      'INVALID_SCOPE_TARGET',
      `${provider} scope targets are ${PROVIDER_KINDS[provider].join(' or ')}, not ${kind}`
    );
  }
  const integrations = service ?? (await integrationsService());
  return provider === 'gitlab'
    ? integrations.lookupGitLabScopeTargetPath(user, connectorId, kind as 'group' | 'project', path)
    : integrations.lookupGitHubScopeTargetPath(user, connectorId, kind as 'owner' | 'repo', path);
}

function pathQualifierOf(scope: string) {
  const base = extractBaseScope(scope);
  if (scope === base || !isGitScopeBase(base)) return null;
  const qualifier = scope.slice(base.length + 1);
  const parsed = parseGitScopePathQualifier(qualifier);
  return parsed ? { base, qualifier, parsed } : null;
}

/** Whether any scope carries a save-time path qualifier (`<connectorId>/<kind>/path/<path>`). */
export function hasGitScopePathQualifiers(scopes: readonly string[]): boolean {
  return scopes.some((scope) => pathQualifierOf(scope) !== null);
}

/**
 * Replace path qualifiers (`<scope>:<connectorId>/group/path/team/sub`) in scopes about to be saved with the
 * stable ID qualifier (`<scope>:<connectorId>/group/123`), looking each path up as the actor (so only paths the
 * actor may view resolve). Only IDs are stored: a group renamed or moved later keeps its grant. Scopes without a
 * path qualifier pass through unchanged. A path that does not resolve fails the save with 400.
 */
export async function resolveGitScopePathQualifiers(
  principal: Pick<User, 'id' | 'scopes' | 'accountScopes'>,
  scopes: readonly string[],
  service?: IntegrationsService
): Promise<string[]> {
  if (!hasGitScopePathQualifiers(scopes)) return [...scopes];
  const integrations = service ?? (await integrationsService());
  // The lookups read only the principal's ID and scopes.
  const actor = principal as User;
  const resolved = new Map<string, Promise<string>>();
  return Promise.all(
    scopes.map(async (scope) => {
      const target = pathQualifierOf(scope);
      if (!target) return scope;
      const { base, qualifier, parsed } = target;
      const issue = gitScopePathQualifierIssue(base, qualifier);
      const provider = gitScopeProviderOf(base);
      if (issue || (provider !== 'gitlab' && provider !== 'github')) {
        const reason = issue ?? `${base} cannot be restricted to a path`;
        throw new AppError(400, 'INVALID_SCOPE_TARGET', `${reason}: ${scope}`);
      }
      const key = `${provider}:${parsed.connectorId}:${parsed.kind}:${parsed.path.toLowerCase()}`;
      let stable = resolved.get(key);
      if (!stable) {
        stable = lookupGitScopeTargetPath(
          actor,
          provider,
          parsed.connectorId,
          parsed.kind,
          parsed.path,
          integrations
        ).then(
          (found) => `${parsed.connectorId}/${found.qualifier}`,
          (error: unknown) => {
            const reason = error instanceof AppError ? error.message : 'the lookup failed';
            throw new AppError(400, 'INVALID_SCOPE_TARGET', `Cannot resolve ${scope}: ${reason}`);
          }
        );
        resolved.set(key, stable);
      }
      return `${base}:${await stable}`;
    })
  );
}
