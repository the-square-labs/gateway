import { UpdateDomainSchema } from '@/modules/domains/domain.schemas.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit } from './ai.service-helpers.js';

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
      return context.domainsService.listDomains({
        search: a.search,
        page: agentPage(a.page),
        limit: agentPageLimit(a.limit),
      });
    case 'create_domain':
      return context.domainsService.createDomain(
        {
          domain: a.domain,
          description: a.description,
          ttl: typeof a.ttl === 'number' ? a.ttl : undefined,
          proxied: typeof a.proxied === 'boolean' ? a.proxied : undefined,
          overwriteDns: a.overwriteDns === true,
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
        return context.domainsService.updateDomain(a.domainId, UpdateDomainSchema.parse(args), user.id);
      }
      if (a.operation === 'check_dns') {
        context.ensureToolScopeForResource(user, 'domains:edit', String(a.domainId));
        return context.domainsService.checkDns(a.domainId);
      }
      throw new Error(`Unsupported domain operation: ${String(a.operation)}`);
    default:
      throw new Error(`Unsupported domain tool: ${toolName}`);
  }
}
