import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '@/types.js';

export const SCALAR_API_REFERENCE_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.62.1';
const SCALAR_CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const SCALAR_API_ORIGIN = 'https://api.scalar.com';

const baseContentSecurityPolicy = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  fontSrc: ["'self'", 'data:'],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  manifestSrc: ["'self'"],
  mediaSrc: ["'self'", 'blob:'],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  styleSrcAttr: ["'unsafe-inline'"],
  styleSrcElem: ["'self'", "'unsafe-inline'"],
  workerSrc: ["'self'", 'blob:'],
};

const docsContentSecurityPolicy = {
  ...baseContentSecurityPolicy,
  connectSrc: ["'self'", SCALAR_CDN_ORIGIN, SCALAR_API_ORIGIN],
  scriptSrc: ["'self'", SCALAR_CDN_ORIGIN, "'unsafe-inline'"],
  scriptSrcElem: ["'self'", SCALAR_CDN_ORIGIN, "'unsafe-inline'"],
  styleSrc: ["'self'", SCALAR_CDN_ORIGIN, "'unsafe-inline'"],
  styleSrcElem: ["'self'", SCALAR_CDN_ORIGIN, "'unsafe-inline'"],
  fontSrc: ["'self'", 'https:', 'data:'],
  imgSrc: ["'self'", SCALAR_CDN_ORIGIN, 'data:', 'blob:'],
};

const oauthConsentContentSecurityPolicy = {
  ...baseContentSecurityPolicy,
  frameSrc: ['http:'],
};

const appSecureHeaders = secureHeaders({ contentSecurityPolicy: baseContentSecurityPolicy });
const docsSecureHeaders = secureHeaders({ contentSecurityPolicy: docsContentSecurityPolicy });
const oauthConsentSecureHeaders = secureHeaders({ contentSecurityPolicy: oauthConsentContentSecurityPolicy });

export const securityHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const middleware =
    path === '/docs' || path.startsWith('/docs/')
      ? docsSecureHeaders
      : path === '/oauth/consent'
        ? oauthConsentSecureHeaders
        : appSecureHeaders;
  await middleware(c, next);
};
