import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import type { AppEnv } from '@/types.js';

function extractSetupToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token.startsWith('gwo_') ? token : null;
}

export const inferenceSetupAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const rawToken = extractSetupToken(c.req.header('Authorization'));
  if (!rawToken) throw new HTTPException(401, { message: 'A Gateway inference setup OAuth token is required' });

  const oauth = container.resolve(OAuthService);
  const result = await oauth.validateAccessToken(rawToken, { resource: oauth.getInferenceSetupResourceUrl() });
  if (!result?.scopes.includes('inference:setup')) {
    throw new HTTPException(401, { message: 'Invalid or expired inference setup OAuth token' });
  }

  c.set('user', result.user);
  c.set('effectiveScopes', result.scopes);
  c.set('isTokenAuth', true);
  c.set('authType', 'oauth-token');
  await next();
};

export const __testOnly = { extractSetupToken };
