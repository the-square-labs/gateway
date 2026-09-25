import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

type TlsResyncTarget = 'route' | 'certificate';

const RESOURCE_SCOPE: Record<TlsResyncTarget, string> = {
  route: 'proxy:edit',
  certificate: 'ssl:cert:issue',
};

async function isSystemResource(db: DrizzleClient, target: TlsResyncTarget, id: string): Promise<boolean> {
  const [row] =
    target === 'route'
      ? await db.select({ isSystem: proxyHosts.isSystem }).from(proxyHosts).where(eq(proxyHosts.id, id)).limit(1)
      : await db
          .select({ isSystem: sslCertificates.isSystem })
          .from(sslCertificates)
          .where(eq(sslCertificates.id, id))
          .limit(1);
  return row?.isSystem === true;
}

/**
 * Retrying TLS delivery is an edit of the route (proxy:edit:<id>) or an issue action on the
 * certificate (ssl:cert:issue:<id>). System routes and system certificates stay operator-only
 * (admin:update), and admin:update keeps working for every target for one release (rc.9).
 * Shared by the REST routes and the AI/MCP resync tool.
 */
export async function assertTlsResyncAccess(
  scopes: string[],
  target: TlsResyncTarget,
  id: string,
  db?: DrizzleClient
): Promise<void> {
  if (hasScope(scopes, 'admin:update')) return;
  const requiredScope = `${RESOURCE_SCOPE[target]}:${id}`;
  if (!hasScope(scopes, requiredScope)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`, { requiredScope });
  }
  if (await isSystemResource(db ?? container.resolve<DrizzleClient>(TOKENS.DrizzleClient), target, id)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      target === 'route'
        ? 'Retrying TLS delivery for a system route requires admin:update'
        : 'Retrying delivery of a system certificate requires admin:update',
      { requiredScope: 'admin:update' }
    );
  }
}
