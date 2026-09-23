import { container } from '@/container.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { DomainIngressMigrationSchema, UpdateDomainSchema } from '@/modules/domains/domain.schemas.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const DOMAIN_TOOL_NAMES = new Set(['list_domains', 'create_domain', 'delete_domain', 'manage_domain']);

export interface DomainToolContext {
  domainsService: DomainsService;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executeDomainTool(
  context: DomainToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_domains':
      return context.domainsService.listDomains(
        {
          search: a.search,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        },
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'domains:view') }
      );
    case 'create_domain':
      if (!hasScopeForCreation(user.scopes, 'domains:create', a.folderId, a.nginxNodeId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing domains:create permission for the selected destination');
      }
      await container.resolve(DomainFolderService).assertFolderExists(a.folderId);
      return context.domainsService.createDomain(
        {
          domain: a.domain,
          description: a.description,
          folderId: a.folderId,
          ttl: typeof a.ttl === 'number' ? a.ttl : undefined,
          proxied: typeof a.proxied === 'boolean' ? a.proxied : undefined,
          overwriteDns: a.overwriteDns === true,
          nginxNodeId: typeof a.nginxNodeId === 'string' ? a.nginxNodeId : undefined,
        },
        user.id
      );
    case 'delete_domain':
      await context.domainsService.deleteDomain(a.domainId, user.id, {
        deleteDns: typeof a.deleteDns === 'boolean' ? a.deleteDns : undefined,
      });
      return { success: true };
    case 'manage_domain':
      if (a.operation === 'get') {
        context.ensureToolScopeForResource(user, 'domains:view', String(a.domainId));
        return context.domainsService.getDomain(a.domainId);
      }
      if (a.operation === 'update') {
        context.ensureToolScopeForResource(user, 'domains:edit', String(a.domainId));
        if (typeof a.proxied === 'boolean') {
          context.ensureToolScopeForResource(user, 'integrations:cloudflare:dns:edit', String(a.domainId));
        }
        return context.domainsService.updateDomain(a.domainId, UpdateDomainSchema.parse(args), user.id);
      }
      if (a.operation === 'check_dns') {
        context.ensureToolScopeForResource(user, 'domains:edit', String(a.domainId));
        return context.domainsService.checkDns(a.domainId);
      }
      if (a.operation === 'preview_ingress_migration' || a.operation === 'migrate_ingress') {
        context.ensureToolScopeForResource(user, 'domains:edit', String(a.domainId));
        const input = DomainIngressMigrationSchema.parse({ targetNodeId: a.targetNodeId });
        return a.operation === 'preview_ingress_migration'
          ? context.domainsService.previewIngressMigration(a.domainId, input)
          : context.domainsService.migrateIngress(a.domainId, input, user.id, user.scopes);
      }
      if (a.operation === 'issue_certificate') {
        // Mirrors POST /domains/{id}/issue-cert: domain edit plus broad ssl:cert:issue.
        context.ensureToolScopeForResource(user, 'domains:edit', String(a.domainId));
        if (!hasScope(user.scopes, 'ssl:cert:issue')) {
          throw new AppError(403, 'FORBIDDEN', 'Missing required scope: ssl:cert:issue');
        }
        const domain = await context.domainsService.getDomain(a.domainId);
        const cloudflare = domain.dnsProvider === 'cloudflare';
        return container.resolve(SSLService).requestACMECert(
          {
            domains: [domain.domain],
            challengeType: cloudflare ? 'dns-01' : 'http-01',
            provider: 'letsencrypt',
            autoRenew: true,
            ...(cloudflare ? { dnsProvider: 'cloudflare' as const } : {}),
          },
          user.id,
          user.email
        );
      }
      throw new Error(`Unsupported domain operation: ${String(a.operation)}`);
    default:
      throw new Error(`Unsupported domain tool: ${toolName}`);
  }
}
