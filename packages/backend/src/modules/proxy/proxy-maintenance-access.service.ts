import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';

const CODE_TTL_SECONDS = 5 * 60;
const CODE_PREFIX = 'proxy-maintenance-access:code:';
const MAINTENANCE_ACCESS_CAPABILITY = 'proxy_maintenance_access_v1';

type AccessCode = { hostId: string; nodeId: string; userId: string };
function digest(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export class ProxyMaintenanceAccessService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService
  ) {}

  async issue(hostId: string, userId: string): Promise<{ code: string; expiresInSeconds: number }> {
    const host = await this.requireMaintainedHost(hostId);
    if (!host.nodeId) throw new AppError(409, 'MAINTENANCE_ACCESS_UNAVAILABLE', 'Proxy host has no nginx node');
    await this.requireSupportedNode(host.nodeId);

    const code = randomBytes(24).toString('base64url');
    await this.cache.set(
      `${CODE_PREFIX}${digest(code)}`,
      { hostId, nodeId: host.nodeId, userId } satisfies AccessCode,
      CODE_TTL_SECONDS
    );
    await this.audit.log({
      userId,
      action: 'proxy_host.maintenance_access.issue',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { expiresInSeconds: CODE_TTL_SECONDS },
    });
    return { code, expiresInSeconds: CODE_TTL_SECONDS };
  }

  async redeem(hostId: string, nodeId: string, requestHost: string, code: string): Promise<string | null> {
    const raw = await this.cache.getClient().getdel(`${CODE_PREFIX}${digest(code)}`);
    if (!raw) return null;
    let grant: AccessCode;
    try {
      grant = JSON.parse(raw) as AccessCode;
    } catch {
      return null;
    }
    if (grant.hostId !== hostId || grant.nodeId !== nodeId) return null;
    const host = await this.requireMaintainedHost(hostId).catch(() => null);
    if (
      !host ||
      host.nodeId !== nodeId ||
      !host.domainNames.some((domain) => domain.toLowerCase() === requestHost.toLowerCase())
    ) {
      return null;
    }
    const user = await resolveLiveUser(this.db, grant.userId);
    if (!user || user.isBlocked || !hasScopeForResource(user.scopes, 'proxy:maintenance:bypass', hostId)) return null;
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = createHash('md5')
      .update(`${expiresAt}${requestHost}${this.secretForHost(hostId)}`)
      .digest('base64url');
    await this.audit.log({
      userId: grant.userId,
      action: 'proxy_host.maintenance_access.redeem',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId },
    });
    return `${signature},${expiresAt}`;
  }

  secretForHost(hostId: string) {
    return this.crypto.deriveScopedSecret(`proxy-maintenance-access:${hostId}`);
  }

  async isNodeSupported(nodeId: string | null): Promise<boolean> {
    if (!nodeId) return false;
    const node = await this.db.query.nodes.findFirst({ where: eq(nodes.id, nodeId) });
    const capabilities = node?.capabilities as Record<string, unknown> | null | undefined;
    const reported = capabilities?.capabilities;
    return (
      node?.type === 'nginx' &&
      node.status === 'online' &&
      Array.isArray(reported) &&
      reported.includes(MAINTENANCE_ACCESS_CAPABILITY)
    );
  }

  private async requireMaintainedHost(hostId: string) {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (
      !host ||
      host.isSystem ||
      host.type !== 'proxy' ||
      host.rawConfigEnabled ||
      !host.enabled ||
      !host.maintenanceEnabled
    ) {
      throw new AppError(404, 'MAINTENANCE_ACCESS_UNAVAILABLE', 'Maintenance access is unavailable');
    }
    return host;
  }

  private async requireSupportedNode(nodeId: string) {
    if (!(await this.isNodeSupported(nodeId))) {
      throw new AppError(
        409,
        'MAINTENANCE_ACCESS_UNAVAILABLE',
        'Maintenance access requires an online nginx daemon with maintenance access support'
      );
    }
  }
}
