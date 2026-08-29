import { container } from '@/container.js';
import { canManageUser, isScopeSubset } from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { UpdateAuthProvisioningSettingsSchema } from '@/modules/admin/admin.schemas.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { CreateTokenSchema, UpdateTokenSchema } from '@/modules/tokens/tokens.schemas.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import type { User } from '@/types.js';
import { AIServiceInteractionTools } from './ai.service.interaction-tools.js';
import { isRecord, type ToolRuntimeContext, UNHANDLED_TOOL } from './ai.service.runtime-helpers.js';
import { aiSettingsUpdatesFromArgs, getEffectiveGroupScopes } from './ai.service.tool-helpers.js';
import { AI_TOOLS } from './ai.tools.js';
import { AIConversationService } from './ai-conversation.service.js';

export abstract class AIServiceAdministrationTools extends AIServiceInteractionTools {
  protected async executeAdministrationTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    _runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
      // ── Administration ──
      case 'list_users':
        return this.authService.listUsers();
      case 'create_user': {
        const destGroup = await this.groupService.getGroup(a.groupId);
        if (!isScopeSubset(getEffectiveGroupScopes(destGroup), user.scopes)) {
          throw new Error('Cannot assign a group with permissions you do not possess');
        }
        return this.authService.createUser({
          email: a.email,
          name: a.name,
          groupId: a.groupId,
        });
      }
      case 'update_user_role': {
        if (a.userId === user.id) {
          throw new Error('Cannot change your own group');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('Deleted users must be restored before they can be changed');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot modify the system user');
        }
        await this.authService.assertCanUpdateUserGroup(user.id, user.scopes, a.userId, a.groupId);
        return this.authService.updateUserGroup(a.userId, a.groupId);
      }
      case 'set_user_additional_permissions': {
        if (
          !Array.isArray(a.additionalScopes) ||
          a.additionalScopes.some((scope: unknown) => typeof scope !== 'string')
        ) {
          throw new Error('additionalScopes must be an array of permission scope strings');
        }
        const requestedScopes = a.additionalScopes as string[];
        const { additionalScopes } = await this.authService.assertCanUpdateUserAdditionalScopes(
          user.id,
          user.scopes,
          a.userId,
          requestedScopes
        );
        return this.authService.updateUserAdditionalScopes(a.userId, additionalScopes);
      }
      case 'set_user_blocked': {
        if (a.userId === user.id) {
          throw new Error('Cannot block yourself');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('Deleted users must be restored before they can be changed');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot modify the system user');
        }
        const denyReason = canManageUser(user.scopes, targetUser.scopes);
        if (denyReason) throw new Error(denyReason);
        return a.blocked ? this.authService.blockUser(a.userId) : this.authService.unblockUser(a.userId);
      }
      case 'delete_user': {
        if (a.userId === user.id) {
          throw new Error('Cannot delete your own account');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('User is already deleted');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot delete the system user');
        }
        const denyReason = canManageUser(user.scopes, targetUser.scopes);
        if (denyReason) throw new Error(denyReason);
        await this.authService.deleteUser(a.userId, user.id);
        return { success: true };
      }
      case 'get_ai_settings': {
        const [config, gatewayInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, gatewayInferenceModels };
      }
      case 'update_ai_settings': {
        const updates = aiSettingsUpdatesFromArgs(args);
        if (Object.keys(updates).length === 0) {
          throw new Error('No supported AI settings fields were provided');
        }
        await this.settingsService.updateConfig(updates);
        const [config, gatewayInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, gatewayInferenceModels };
      }
      case 'list_ai_tools':
        return AI_TOOLS.map((tool) => ({
          name: tool.name,
          category: tool.category,
          description: tool.description,
          destructive: tool.destructive,
          requiredScope: tool.requiredScope,
          invalidateStores: tool.invalidateStores,
        }));
      case 'get_sandbox_runtime_status': {
        const config = await this.settingsService.getConfig();
        const status = this.sandboxService?.status() ?? { status: 'unconfigured' };
        const health = this.sandboxService
          ? await this.sandboxService.health().catch((error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          : { ok: false, error: 'Sandbox runner is not configured' };
        return {
          enabled: config.sandboxEnabled,
          defaultTier: config.sandboxDefaultTier,
          status,
          health,
        };
      }
      case 'manage_ai_conversation': {
        const conversationService = container.resolve(AIConversationService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return conversationService.listConversations(user.id);
          case 'get': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const conversation = await conversationService.getConversation(user.id, conversationId);
            if (!conversation) throw new Error('Conversation not found');
            return conversation;
          }
          case 'delete': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const deleted = await conversationService.deleteConversation(user.id, conversationId);
            if (!deleted) throw new Error('Conversation not found');
            return { deleted: true };
          }
          case 'delete_by_title': {
            const title = String(a.title ?? '');
            if (!title.trim()) throw new Error('title is required');
            return { deleted: await conversationService.deleteConversationByTitle(user.id, title) };
          }
          default:
            throw new Error('Unsupported conversation operation');
        }
      }
      case 'manage_oauth_authorization': {
        const { OAuthService } = await import('@/modules/oauth/oauth.service.js');
        const oauthService = container.resolve(OAuthService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return oauthService.listUserAuthorizations(user.id);
          case 'update_scopes': {
            const clientId = String(a.clientId ?? '');
            const resource = String(a.resource ?? '');
            const scopes = Array.isArray(a.scopes) ? a.scopes.map(String) : [];
            if (!clientId) throw new Error('clientId is required');
            if (!resource) throw new Error('resource is required');
            if (scopes.length === 0) throw new Error('scopes are required');
            return oauthService.updateUserAuthorizationScopes(user, clientId, resource, scopes);
          }
          case 'revoke': {
            const clientId = String(a.clientId ?? '');
            const resource = String(a.resource ?? '');
            if (!clientId) throw new Error('clientId is required');
            if (!resource) throw new Error('resource is required');
            await oauthService.revokeUserAuthorization(user.id, clientId, resource);
            return { revoked: true };
          }
          default:
            throw new Error('Unsupported OAuth authorization operation');
        }
      }
      case 'manage_api_token': {
        const tokensService = container.resolve(TokensService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return tokensService.listTokens(user.id);
          case 'create': {
            const input = CreateTokenSchema.parse({
              name: a.name,
              scopes: Array.isArray(a.scopes) ? canonicalizeScopes(a.scopes.map(String)) : a.scopes,
            });
            if (!isScopeSubset(input.scopes, user.scopes)) {
              throw new Error('Cannot create a token with scopes you do not possess');
            }
            return tokensService.createToken(user.id, input);
          }
          case 'update': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            const input = UpdateTokenSchema.parse({
              name: a.name,
              scopes: Array.isArray(a.scopes) ? canonicalizeScopes(a.scopes.map(String)) : a.scopes,
            });
            if (input.scopes !== undefined && !isScopeSubset(input.scopes, user.scopes)) {
              throw new Error('Cannot update a token with scopes you do not possess');
            }
            await tokensService.updateToken(user.id, tokenId, input);
            return { success: true };
          }
          case 'revoke': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            await tokensService.revokeToken(user.id, tokenId);
            return { success: true };
          }
          default:
            throw new Error('Unsupported API token operation');
        }
      }
      case 'get_license_status':
        return container.resolve(LicenseService).getStatus();
      case 'manage_license': {
        const service = container.resolve(LicenseService);
        switch (a.operation) {
          case 'activate':
            return service.activateKey(String(a.licenseKey ?? ''));
          case 'check':
            return service.checkNow();
          case 'clear':
            return service.clearKey();
          default:
            throw new Error('Unsupported license operation');
        }
      }
      case 'manage_housekeeping': {
        const service = container.resolve(HousekeepingService);
        switch (a.operation) {
          case 'get_config':
            return service.getConfig();
          case 'get_stats':
            return service.getStats();
          case 'get_history':
            return service.getRunHistory();
          case 'update_config': {
            this.ensureToolScope(user, 'housekeeping:configure');
            const config = isRecord(a.config) ? a.config : {};
            const updated = await service.updateConfig(config as Parameters<typeof service.updateConfig>[0]);
            if (typeof config.cronExpression === 'string') {
              container.resolve(SchedulerService).updateSchedule('housekeeping', config.cronExpression);
            }
            return updated;
          }
          case 'run':
            this.ensureToolScope(user, 'housekeeping:run');
            return service.runAll('manual', user.id);
          default:
            throw new Error('Unsupported housekeeping operation');
        }
      }
      case 'get_gateway_settings': {
        const authSettingsService = container.resolve(AuthSettingsService);
        const mcpSettingsService = container.resolve(McpSettingsService);
        const generalSettingsService = container.resolve(GeneralSettingsService);
        const networkSettingsService = container.resolve(NetworkSettingsService);
        const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
        const [settings, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy, groups] =
          await Promise.all([
            authSettingsService.getConfig(),
            mcpSettingsService.getConfig(),
            generalSettingsService.getConfig(),
            networkSettingsService.getConfig(),
            outboundWebhookPolicyService.getConfig(),
            this.groupService.listGroups(),
          ]);
        const availableGroups = groups
          .filter((group) => isScopeSubset(getEffectiveGroupScopes(group), user.scopes))
          .map((group) => ({ id: group.id, name: group.name, isBuiltin: group.isBuiltin }));
        return {
          ...settings,
          mcpServerEnabled: mcpSettings.serverEnabled,
          mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
          generalSettings,
          networkSecurity,
          outboundWebhookPolicy,
          availableGroups,
        };
      }
      case 'update_gateway_settings': {
        const input = UpdateAuthProvisioningSettingsSchema.parse(args);
        if (input.oidcDefaultGroupId) {
          const destGroup = await this.groupService.getGroup(input.oidcDefaultGroupId);
          if (!isScopeSubset(getEffectiveGroupScopes(destGroup), user.scopes)) {
            throw new Error('Cannot assign a group with permissions you do not possess');
          }
        }
        const authSettingsService = container.resolve(AuthSettingsService);
        const mcpSettingsService = container.resolve(McpSettingsService);
        const generalSettingsService = container.resolve(GeneralSettingsService);
        const networkSettingsService = container.resolve(NetworkSettingsService);
        const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
        const [settings, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy] = await Promise.all([
          authSettingsService.updateConfig(input),
          mcpSettingsService.updateConfig({
            serverEnabled: input.mcpServerEnabled,
            extendedCompatibility: input.mcpExtendedCompatibility,
          }),
          input.generalSettings
            ? generalSettingsService.updateConfig(input.generalSettings)
            : generalSettingsService.getConfig(),
          input.networkSecurity
            ? networkSettingsService.updateConfig(input.networkSecurity)
            : networkSettingsService.getConfig(),
          input.outboundWebhookPolicy
            ? outboundWebhookPolicyService.updateConfig(input.outboundWebhookPolicy)
            : outboundWebhookPolicyService.getConfig(),
        ]);
        const groups = await this.groupService.listGroups();
        const availableGroups = groups
          .filter((group) => isScopeSubset(getEffectiveGroupScopes(group), user.scopes))
          .map((group) => ({ id: group.id, name: group.name, isBuiltin: group.isBuiltin }));
        this.eventBus?.publish('system.config.changed', { action: 'gateway_settings_updated' });
        return {
          ...settings,
          mcpServerEnabled: mcpSettings.serverEnabled,
          mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
          generalSettings,
          networkSecurity,
          outboundWebhookPolicy,
          availableGroups,
        };
      }
      default:
        return UNHANDLED_TOOL;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
