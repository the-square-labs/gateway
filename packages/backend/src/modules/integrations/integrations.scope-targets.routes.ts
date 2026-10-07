import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import type { AppEnv, User } from '@/types.js';
import { lookupGitScopeTargetPath } from './git-scope-paths.js';
import {
  ScopeTargetLookupQuerySchema,
  ScopeTargetParamsSchema,
  ScopeTargetResolveQuerySchema,
  ScopeTargetSearchQuerySchema,
  scopeTargetRateLimiter,
} from './git-scope-targets.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import {
  listGitScopeTargetsRoute,
  lookupGitScopeTargetRoute,
  resolveGitScopeTargetsRoute,
} from './integrations.docs.js';
import { IntegrationsService } from './integrations.service.js';

type RequestContext = { get(name: 'user'): User | undefined; get(name: 'effectiveScopes'): string[] | undefined };

/** The request's scopes: the bounded token scopes for bearer tokens, the session's effective scopes otherwise. */
export function requestScopes(c: RequestContext) {
  return c.get('effectiveScopes') ?? c.get('user')?.scopes ?? [];
}

/** The caller as services see it: the account with the request's scopes. */
export function requestActor(c: RequestContext) {
  return { ...c.get('user')!, scopes: requestScopes(c) };
}

/**
 * Scope picker access: `integrations:<provider>:view` on the connector or anything in it (results are filtered),
 * and a per-account request limit.
 */
const requireScopeTargetAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { provider, connectorId } = ScopeTargetParamsSchema.parse({
    provider: c.req.param('provider'),
    connectorId: c.req.param('connectorId'),
  });
  const user = c.get('user')!;
  assertConnectorOperationAccess({
    actor: { userId: user.id, scopes: requestScopes(c), accountScopes: user.accountScopes },
    provider,
    connectorId,
    operation: 'connector.scope_targets',
    requiredScope: `integrations:${provider}:view`,
    scopeTarget: 'within-connector',
  });
  // Searches and label lookups spend the connector's provider API budget: limit them per account.
  scopeTargetRateLimiter.consume(user.id);
  await next();
};

/** The Git scope picker routes: search, labels for stored qualifiers, and path lookup. */
export function registerGitScopeTargetRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi({ ...listGitScopeTargetsRoute, middleware: requireScopeTargetAccess }, async (c) => {
    const { provider, connectorId } = ScopeTargetParamsSchema.parse({
      provider: c.req.param('provider'),
      connectorId: c.req.param('connectorId'),
    });
    const query = ScopeTargetSearchQuerySchema.parse(c.req.query());
    const service = container.resolve(IntegrationsService);
    const actor = requestActor(c);
    return c.json(
      provider === 'gitlab'
        ? await service.listGitLabScopeTargets(actor, connectorId, query)
        : await service.listGitHubScopeTargets(actor, connectorId, query)
    );
  });

  app.openapi({ ...resolveGitScopeTargetsRoute, middleware: requireScopeTargetAccess }, async (c) => {
    const { provider, connectorId } = ScopeTargetParamsSchema.parse({
      provider: c.req.param('provider'),
      connectorId: c.req.param('connectorId'),
    });
    const { ids } = ScopeTargetResolveQuerySchema.parse(c.req.query());
    const service = container.resolve(IntegrationsService);
    const actor = requestActor(c);
    return c.json(
      provider === 'gitlab'
        ? await service.resolveGitLabScopeTargets(actor, connectorId, ids)
        : await service.resolveGitHubScopeTargets(actor, connectorId, ids)
    );
  });

  app.openapi({ ...lookupGitScopeTargetRoute, middleware: requireScopeTargetAccess }, async (c) => {
    const { provider, connectorId } = ScopeTargetParamsSchema.parse({
      provider: c.req.param('provider'),
      connectorId: c.req.param('connectorId'),
    });
    const { kind, path } = ScopeTargetLookupQuerySchema.parse(c.req.query());
    return c.json(await lookupGitScopeTargetPath(requestActor(c), provider, connectorId, kind, path));
  });
}
