import { Hono } from 'hono';
import type { AppEnv } from '@/types.js';
import { publishPageUploadLink } from './page-upload-link.js';

/**
 * One-time Pages upload links, mounted at PAGE_UPLOAD_LINK_PATH. The link
 * token is the credential: it was issued to an authenticated Pages deployer
 * and is consumed by the first request, whatever its outcome.
 */
export const pageUploadLinkRoutes = new Hono<AppEnv>();

// `curl --data-binary` without -X sends POST; both carry the raw artifact bytes.
pageUploadLinkRoutes.on(['PUT', 'POST'], '/:token', async (c) => {
  const data = await publishPageUploadLink(c.req.param('token'), c.req.raw.body);
  return c.json({ data });
});
