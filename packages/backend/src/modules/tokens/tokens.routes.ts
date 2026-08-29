import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { isScopeSubset } from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { createTokenRoute, listTokensRoute, renameTokenRoute, revokeTokenRoute } from './tokens.docs.js';
import { CreateTokenSchema, UpdateTokenSchema } from './tokens.schemas.js';
import { TokensService } from './tokens.service.js';

export const tokensRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

export function assertTokenManagementSession(impersonation: unknown): void {
  if (impersonation) {
    throw new AppError(
      403,
      'IMPERSONATION_TOKEN_MANAGEMENT_FORBIDDEN',
      'API tokens cannot be managed while impersonating'
    );
  }
}

tokensRoutes.use('*', authMiddleware);
tokensRoutes.use('*', sessionOnly);
tokensRoutes.use('*', async (c, next) => {
  assertTokenManagementSession(c.get('impersonation'));
  await next();
});

tokensRoutes.openapi(listTokensRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const tokens = await tokensService.listTokens(user.id);
  return c.json(tokens);
});

tokensRoutes.openapi(createTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const parsedInput = CreateTokenSchema.parse(body);
  const input = { ...parsedInput, scopes: canonicalizeScopes(parsedInput.scopes) };

  // Token scopes must be a subset of the user's group scopes
  const userScopes = user.scopes;
  if (!isScopeSubset(input.scopes, userScopes)) {
    const disallowed = input.scopes.filter((s) => !TokensService.hasScope(userScopes, s));
    return c.json(
      { code: 'SCOPE_NOT_ALLOWED', message: `Your group cannot grant scopes: ${disallowed.join(', ')}` },
      403
    );
  }

  const result = await tokensService.createToken(user.id, input);
  return c.json(result, 201);
});

tokensRoutes.openapi(renameTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const parsedInput = UpdateTokenSchema.parse(await c.req.json());
  const input = {
    ...parsedInput,
    ...(parsedInput.name !== undefined ? { name: parsedInput.name.trim() } : {}),
    ...(parsedInput.scopes !== undefined ? { scopes: canonicalizeScopes(parsedInput.scopes) } : {}),
  };

  if (input.scopes !== undefined && !isScopeSubset(input.scopes, user.scopes)) {
    const disallowed = input.scopes.filter((s) => !TokensService.hasScope(user.scopes, s));
    return c.json(
      { code: 'SCOPE_NOT_ALLOWED', message: `Your group cannot grant scopes: ${disallowed.join(', ')}` },
      403
    );
  }

  await tokensService.updateToken(user.id, id, input);
  return c.json({ success: true });
});

tokensRoutes.openapi(revokeTokenRoute, async (c) => {
  const tokensService = container.resolve(TokensService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  await tokensService.revokeToken(user.id, id);
  return c.body(null, 204);
});
