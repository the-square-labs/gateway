import { Hono } from 'hono';
import type { AppEnv } from '@/types.js';
import { openStorageObjectDownloadLink } from './ai.storage-object-link.js';

/**
 * One-time storage object download links, mounted at STORAGE_OBJECT_LINK_PATH. The link token is the credential:
 * it was issued to an authenticated MCP caller and is consumed by the first request, whatever its outcome.
 */
export const storageObjectLinkRoutes = new Hono<AppEnv>();

storageObjectLinkRoutes.get('/:token', async (c) => {
  // Hono answers HEAD with the GET handler; a probe must not use up the link.
  if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' });
  return openStorageObjectDownloadLink(c.req.param('token'));
});
