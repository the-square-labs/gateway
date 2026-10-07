import { lookupGitScopeTargetPath } from '@/modules/integrations/git-scope-paths.js';
import {
  ScopeTargetLookupQuerySchema,
  ScopeTargetParamsSchema,
  scopeTargetRateLimiter,
} from '@/modules/integrations/git-scope-targets.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';

export const GIT_SCOPE_TARGET_TOOL_NAMES = new Set(['find_git_scope_target']);

export const GIT_SCOPE_TARGET_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'find_git_scope_target',
    description:
      'Resolve a GitLab group or project path (team/sub, team/sub/app) or a GitHub owner login or owner/repository to the stable qualifier Git scopes store, like GET /integrations/{provider}/{connectorId}/scope-targets/lookup. Returns qualifier relative to the connector (group/123); the full scope is <scope>:<connectorId>/<qualifier>, for example integrations:gitlab:use:<connectorId>/group/123 (a group also covers its subgroups). Needs integrations:<provider>:view on the connector or on anything in it; a path the caller may not view or outside the connector allowlist is reported as not found. Get connectorId from list_integration_connectors.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['gitlab', 'github'], description: 'Git provider of the connector.' },
        connectorId: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          description: 'Exact connector UUID returned by list_integration_connectors.',
        },
        kind: {
          type: 'string',
          enum: ['group', 'project', 'owner', 'repo'],
          description: 'GitLab: group or project. GitHub: owner (organization or user) or repo.',
        },
        path: {
          type: 'string',
          description: 'Full path: team/sub, team/sub/app, octo-org, or octo-org/app.',
        },
      },
      required: ['provider', 'connectorId', 'kind', 'path'],
    },
    destructive: false,
    category: 'Integrations',
    requiredScope: 'integrations:gitlab:view',
    invalidateStores: [],
    effect: 'read',
    approvalClass: 'read',
    historyRetention: { mode: 'persistent_context' },
  },
];

/** Same access checks, per-account picker limit and answers as the REST lookup route. */
export async function executeGitScopeTargetTool(user: User, args: Record<string, unknown>) {
  const { provider, connectorId } = ScopeTargetParamsSchema.parse({
    provider: args.provider,
    connectorId: typeof args.connectorId === 'string' ? args.connectorId.toLowerCase() : args.connectorId,
  });
  const { kind, path } = ScopeTargetLookupQuerySchema.parse({ kind: args.kind, path: args.path });
  // Lookups spend the connector's provider API budget, like the picker.
  scopeTargetRateLimiter.consume(user.id);
  return lookupGitScopeTargetPath(user, provider, connectorId, kind, path);
}
