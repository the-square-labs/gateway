import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { CreateNginxTemplateSchema, UpdateNginxTemplateSchema } from '@/modules/proxy/nginx-template.schemas.js';
import { RequestACMECertSchema, SetSslAutoRenewSchema, UploadCertSchema } from '@/modules/ssl/ssl.schemas.js';
import type { User } from '@/types.js';
import { AIServiceExecution } from './ai.service.execution.js';
import {
  SEND_COMMENT_EMPTY_ERROR,
  SEND_COMMENT_TOOL_NAME,
  type ToolRuntimeContext,
  UNHANDLED_TOOL,
} from './ai.service.runtime-helpers.js';
import {
  commentMessageFromArgs,
  normalizeReadChatSliceMode,
  normalizeSearchScope,
  stringArg,
} from './ai.service.tool-helpers.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
} from './ai.service-helpers.js';
import { AISkillService } from './ai.skills.js';
import { AIConversationSearchService } from './ai-conversation-search.service.js';

export abstract class AIServiceInteractionTools extends AIServiceExecution {
  protected async executeInteractionTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
      // ── Discovery ──
      case 'discover_tools':
        return this.discoverTools(user, args, runtimeContext.conversationId);

      case 'read_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return { skill, active: false, nextStep: 'Call activate_skill before applying this skill.' };
      }

      case 'activate_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return {
          active: true,
          activationScope: 'current_context',
          priority: skill.source === 'system' ? 'system_skill' : 'organization_skill',
          skill,
          instruction:
            'Apply the activated instructions while they remain in the current context. Do not activate this skill again until compaction removes this activation. Base security, authorization, permission, and approval rules always take priority.',
        };
      }

      case 'get_current_context':
        return {
          currentPage: runtimeContext.pageContext ?? null,
          hasCurrentPage: !!runtimeContext.pageContext?.route,
        };

      case 'wait': {
        const rawSeconds = Number(a.seconds ?? 5);
        const seconds = Math.min(30, Math.max(1, Number.isFinite(rawSeconds) ? rawSeconds : 5));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return {
          waitedSeconds: seconds,
          reason: stringArg(a.reason) ?? null,
          nextStep: 'Call the relevant read/status tool again to verify whether the pending operation completed.',
        };
      }

      case SEND_COMMENT_TOOL_NAME: {
        const message = commentMessageFromArgs(args);
        if (!message) throw new Error(SEND_COMMENT_EMPTY_ERROR);
        return { delivered: true, message };
      }

      case 'end_conversation': {
        const reason = String(a.reason ?? '').trim();
        return {
          ended: true,
          reason: reason || 'This conversation has been ended.',
        };
      }

      case 'find_resource':
        return this.searchResources(user, args, runtimeContext);
      case 'search_chats':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).searchChats(user.id, {
          query: String(a.query ?? ''),
          scope: normalizeSearchScope(a.scope),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'search_compacted_history': {
        if (!runtimeContext.conversationId) {
          throw new AppError(
            409,
            'AI_CONVERSATION_REQUIRED',
            'search_compacted_history requires the current saved conversation'
          );
        }
        return (
          this.conversationSearchService ?? container.resolve(AIConversationSearchService)
        ).searchCompactedHistory(user.id, {
          conversationId: runtimeContext.conversationId,
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
      }
      case 'find_in_chat':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).findInChat(user.id, {
          conversationId: String(a.conversationId ?? ''),
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'read_chat_slice':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).readChatSlice(
          user.id,
          {
            conversationId: String(a.conversationId ?? ''),
            mode: normalizeReadChatSliceMode(a.mode),
            messageId: typeof a.messageId === 'string' ? a.messageId : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );
      case 'list_chat_projects':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).listProjects(
          user.id,
          {
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );

      case 'manage_proxy_template': {
        const { NginxTemplateService } = await import('@/modules/proxy/nginx-template.service.js');
        const templateService = container.resolve(NginxTemplateService);
        if (a.operation === 'list') {
          this.ensureToolScope(user, 'proxy:templates:view');
          return templateService.listTemplates({
            allowedIds: allowedResourceIdsForScopes(user.scopes, 'proxy:templates:view'),
          });
        }
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'proxy:templates:view', String(a.templateId));
          return templateService.getTemplate(a.templateId);
        }
        if (a.operation === 'create') {
          this.ensureToolScope(user, 'proxy:templates:create');
          return templateService.createTemplate(CreateNginxTemplateSchema.parse(args), user.id);
        }
        if (a.operation === 'update') {
          this.ensureToolScopeForResource(user, 'proxy:templates:edit', String(a.templateId));
          return templateService.updateTemplate(a.templateId, UpdateNginxTemplateSchema.parse(args), user.id);
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'proxy:templates:delete', String(a.templateId));
          await templateService.deleteTemplate(a.templateId, user.id);
          return { success: true };
        }
        if (a.operation === 'clone') {
          this.ensureToolScopeForResource(user, 'proxy:templates:edit', String(a.templateId));
          this.ensureToolScope(user, 'proxy:templates:create');
          return templateService.cloneTemplate(a.templateId, user.id);
        }
        throw new Error(`Unsupported proxy template operation: ${String(a.operation)}`);
      }

      // ── SSL Certificates ──
      case 'list_ssl_certificates':
        return this.sslService.listCerts(
          { search: a.search, page: agentPage(a.page), limit: agentPageLimit(a.limit) },
          { allowedIds: allowedResourceIdsForScopes(user.scopes, 'ssl:cert:view') }
        );
      case 'link_internal_cert':
        return this.sslService.linkInternalCert({ internalCertId: a.internalCertId, name: a.name }, user.id);
      case 'request_acme_cert':
        return this.sslService.requestACMECert(RequestACMECertSchema.parse(args), user.id, user.email);
      case 'manage_ssl_certificate': {
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'ssl:cert:view', String(a.sslCertificateId));
          return this.sslService.getCert(a.sslCertificateId);
        }
        if (a.operation === 'upload') {
          this.ensureToolScope(user, 'ssl:cert:issue');
          return this.sslService.uploadCert(UploadCertSchema.parse(args), user.id);
        }
        if (a.operation === 'renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.renewCert(a.sslCertificateId, user.id);
        }
        if (a.operation === 'verify_dns') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.completeDNS01Verification(a.sslCertificateId, user.id);
        }
        if (a.operation === 'set_auto_renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.setAutoRenew(a.sslCertificateId, SetSslAutoRenewSchema.parse(args), user.id);
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'ssl:cert:delete', String(a.sslCertificateId));
          await this.sslService.deleteCert(a.sslCertificateId, user.id);
          return { success: true };
        }
        throw new Error(`Unsupported SSL certificate operation: ${String(a.operation)}`);
      }

      // ── Raw Config ──
      case 'get_route_rendered_config': {
        const host = await this.proxyService.getProxyHost(a.routeId);
        if (!host) throw new Error('Route not found');
        const renderedConfig = await this.proxyService.getRenderedConfig(a.routeId);
        return { routeId: a.routeId, config: renderedConfig };
      }
      case 'update_route_raw_config': {
        const rawHost = await this.proxyService.getProxyHost(a.routeId);
        if (!rawHost) throw new Error('Route not found');
        if (!(rawHost as any).rawConfigEnabled) {
          throw new Error('Raw mode is not enabled on this route. Enable it first with toggle_route_raw_mode.');
        }
        const bypassRawValidation = hasScope(user.scopes, `proxy:raw:bypass:${a.routeId}`);
        return compactProxyHostForAgent(
          await this.proxyService.updateProxyHost(a.routeId, { rawConfig: a.rawConfig } as any, user.id, {
            bypassRawValidation,
          })
        );
      }
      case 'toggle_route_raw_mode': {
        const bypassRawValidation = hasScope(user.scopes, `proxy:raw:bypass:${a.routeId}`);
        return compactProxyHostForAgent(
          await this.proxyService.updateProxyHost(a.routeId, { rawConfigEnabled: a.enabled } as any, user.id, {
            bypassRawValidation,
          })
        );
      }
      default:
        return UNHANDLED_TOOL;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
